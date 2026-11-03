//! Shared bounded text output and ephemeral spill storage.
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{ToolCtx, ToolOutput, clip};
use crate::api::wire::ResultPart;

pub const TEXT_LIMIT: usize = 30_000;
const STORE_LIMIT: u64 = 128 * 1024 * 1024;
const FILE_LIMIT: u64 = 32 * 1024 * 1024;
struct Storage { reserved: std::collections::HashMap<PathBuf, u64> }
static STORAGE: std::sync::LazyLock<Mutex<Storage>> = std::sync::LazyLock::new(|| Mutex::new(Storage { reserved: Default::default() }));

pub struct Spill {
    file: std::fs::File,
    pub path: PathBuf,
    written: u64,
    exhausted: bool,
}
impl Spill {
    pub fn new(ctx: &ToolCtx) -> std::io::Result<Self> {
        Self::at(Path::new("/tmp/gond-agent-output"), &ctx.call_id)
    }
    fn at(dir: &Path, id: &str) -> std::io::Result<Self> {
        let mut storage = STORAGE.lock().unwrap();
        std::fs::create_dir_all(dir)?;
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).filter_map(|e| {
            let m = e.metadata().ok()?;
            if !m.is_file() { return None; }
            let path = e.path();
            Some((m.modified().ok(), *storage.reserved.get(&path).unwrap_or(&m.len()), path))
        }).collect();
        entries.sort_by_key(|e| e.0);
        let mut total: u64 = entries.iter().map(|e| e.1).sum();
        for (_, len, path) in entries {
            if total + FILE_LIMIT <= STORE_LIMIT { break; }
            if storage.reserved.contains_key(&path) { continue; }
            if std::fs::remove_file(path).is_ok() { total = total.saturating_sub(len); }
        }
        if total + FILE_LIMIT > STORE_LIMIT { return Err(std::io::Error::other("Output store is busy; narrow the request")); }
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')).take(100).collect();
        let path = dir.join(format!("{}-{}.txt", if safe.is_empty() { "output" } else { &safe }, uuid::Uuid::new_v4()));
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        storage.reserved.insert(path.clone(), FILE_LIMIT);
        Ok(Self { file, path, written: 0, exhausted: false })
    }
    pub fn push(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let n = (FILE_LIMIT.saturating_sub(self.written) as usize).min(bytes.len());
        self.file.write_all(&bytes[..n])?;
        self.written += n as u64;
        self.exhausted |= n < bytes.len();
        Ok(())
    }
    pub fn hint(&self) -> String {
        format!("\n{} output: {}. Read with read {{\"path\":\"{}\",\"offset\":1,\"limit\":200}} or grep with path and pattern. Ephemeral; oldest files are removed at 128 MiB.{}", if self.exhausted { "Partial" } else { "Full" }, self.path.display(), self.path.display(), if self.exhausted { " Per-call 32 MiB storage limit reached; narrow or redirect the command for more." } else { "" })
    }
}

impl Drop for Spill {
    fn drop(&mut self) {
        STORAGE.lock().unwrap().reserved.remove(&self.path);
        if self.written == 0 { let _ = std::fs::remove_file(&self.path); }
    }
}

pub fn bound(ctx: &ToolCtx, mut out: ToolOutput) -> ToolOutput {
    let text: String = out.content.iter().filter_map(|p| match p { ResultPart::Text { text } => Some(text.as_str()), _ => None }).collect::<Vec<_>>().join("\n");
    if text.len() > TEXT_LIMIT {
        let hint = match Spill::new(ctx).and_then(|mut s| { s.push(text.as_bytes())?; Ok(s.hint()) }) {
            Ok(h) => h,
            Err(_) => "\nCould not save full output; narrow the request or use paging to get more.".into(),
        };
        let mut content = vec![ResultPart::Text { text: format!("{}{hint}", clip(&text, TEXT_LIMIT)) }];
        content.extend(out.content.into_iter().filter(|p| matches!(p, ResultPart::Image { .. })));
        out.content = content;
    }
    for value in std::iter::once(&mut out.display).chain(out.diff.iter_mut()) {
        if value.len() > TEXT_LIMIT {
            let hint = Spill::new(ctx).and_then(|mut s| { s.push(value.as_bytes())?; Ok(s.hint()) }).unwrap_or_else(|_| "\nFull output unavailable; narrow the request to get more.".into());
            *value = format!("{}{hint}", clip(value, TEXT_LIMIT));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_removes_oldest_and_files_report_storage_exhaustion() {
        let dir = tempfile::tempdir().unwrap();
        let oldest = dir.path().join("old.txt");
        std::fs::File::create(&oldest).unwrap().set_len(STORE_LIMIT).unwrap();
        let mut spill = Spill::at(dir.path(), "new").unwrap();
        assert!(!oldest.exists());
        spill.written = FILE_LIMIT;
        spill.push(b"overflow").unwrap();
        assert!(spill.hint().contains("Partial output"));
        assert!(spill.hint().contains("32 MiB"));
    }

    #[test]
    fn spills_full_text_and_sanitizes_identifiers() {
        let dir = tempfile::tempdir().unwrap();
        let mut spill = Spill::at(dir.path(), "../../unsafe").unwrap();
        spill.push(b"hello\nworld").unwrap();
        assert_eq!(std::fs::read(&spill.path).unwrap(), b"hello\nworld");
        assert_eq!(spill.path.parent(), Some(dir.path()));
        let (ctx, _rx) = super::super::testutil::ctx(dir.path());
        let out = bound(&ctx, ToolOutput::ok("x".repeat(TEXT_LIMIT + 1), "large"));
        let text = super::super::testutil::text(&out);
        assert!(text.contains("Full output: /tmp/gond-agent-output/"));
        assert!(text.contains("offset"));
    }
}
