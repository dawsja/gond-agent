use std::path::Path;

use base64::Engine;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use similar::{ChangeTag, TextDiff};

use super::{Tool, ToolCtx, ToolOutput, schema, str_arg};
use crate::api::wire::ResultPart;
use crate::permissions::Access;

const MAX_LINES: usize = 2000;
const MAX_LINE_LEN: usize = 2000;

fn mtime(p: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

fn image_type(p: &Path) -> Option<&'static str> {
    match p.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Unified diff plus added/removed line counts.
pub fn diff(old: &str, new: &str, path: &str) -> (String, usize, usize) {
    let d = TextDiff::from_lines(old, new);
    let (mut add, mut del) = (0, 0);
    for c in d.iter_all_changes() {
        match c.tag() {
            ChangeTag::Insert => add += 1,
            ChangeTag::Delete => del += 1,
            ChangeTag::Equal => {}
        }
    }
    let text = d.unified_diff().context_radius(3).header(&format!("a/{path}"), &format!("b/{path}")).to_string();
    (text, add, del)
}

/// Reject edits to files that were never read, or that changed on disk since the last read.
pub(crate) fn check_fresh(ctx: &ToolCtx, path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let reads = ctx.reads.lock().unwrap();
    match reads.get(path) {
        None => Err(format!("{} has not been read in this session; read it before changing it", ctx.display(path))),
        Some(t) if *t != mtime(path) => Err(format!("{} changed on disk since it was read; read it again", ctx.display(path))),
        Some(_) => Ok(()),
    }
}

pub(crate) fn remember(ctx: &ToolCtx, path: &Path) {
    ctx.reads.lock().unwrap().insert(path.to_path_buf(), mtime(path));
}

pub struct Read;

impl Tool for Read {
    fn name(&self) -> &'static str {
        "read"
    }
    fn description(&self) -> &'static str {
        "Read a file. Returns numbered lines (cat -n style); use offset/limit for large files. Reads images (png, jpg, gif, webp) too. Always read a file before editing it."
    }
    fn schema(&self) -> Value {
        schema(
            json!({
                "path": {"type": "string", "description": "File path, relative to the working directory or absolute"},
                "offset": {"type": "integer", "description": "1-based line to start from"},
                "limit": {"type": "integer", "description": "Maximum lines to return (default 2000)"}
            }),
            &["path"],
        )
    }
    fn access(&self) -> Access {
        Access::Read
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "path").unwrap_or("?").to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(p) = str_arg(&input, "path") else { return ToolOutput::err("path is required") };
            let path = ctx.resolve(p);
            if let Some(mt) = image_type(&path) {
                return match tokio::fs::read(&path).await {
                    Ok(bytes) => {
                        remember(ctx, &path);
                        let kb = bytes.len() / 1024;
                        ToolOutput {
                            ok: true,
                            content: vec![ResultPart::Image { media_type: mt.into(), data: base64::engine::general_purpose::STANDARD.encode(&bytes) }],
                            summary: format!("image · {kb} KB"),
                            display: String::new(),
                            diff: None,
                        }
                    }
                    Err(e) => ToolOutput::err(format!("cannot read {p}: {e}")),
                };
            }
            let text = match tokio::fs::read(&path).await {
                Ok(b) => String::from_utf8_lossy(&b).into_owned(),
                Err(e) => return ToolOutput::err(format!("cannot read {p}: {e}")),
            };
            remember(ctx, &path);
            let total = text.lines().count();
            let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(1).max(1) as usize;
            let limit = input.get("limit").and_then(Value::as_u64).map(|l| l as usize).unwrap_or(MAX_LINES).min(MAX_LINES);
            let mut out = String::new();
            for (i, line) in text.lines().enumerate().skip(offset - 1).take(limit) {
                let line = if line.len() > MAX_LINE_LEN { &line[..super::floor_char(line, MAX_LINE_LEN)] } else { line };
                out.push_str(&format!("{:>6}\t{line}\n", i + 1));
            }
            let shown_end = (offset - 1 + limit).min(total);
            if total == 0 {
                out = "(empty file)".into();
            } else if shown_end < total || offset > 1 {
                out.push_str(&format!("… showing lines {offset}-{shown_end} of {total}\n"));
            }
            let summary = format!("{total} lines");
            ToolOutput { ok: true, display: String::new(), content: vec![ResultPart::Text { text: out }], summary, diff: None }
        })
    }
}

pub struct Write;

impl Tool for Write {
    fn name(&self) -> &'static str {
        "write"
    }
    fn description(&self) -> &'static str {
        "Create or overwrite a file with the given content. Existing files must be read first. Prefer edit for changes to existing files."
    }
    fn schema(&self) -> Value {
        schema(json!({"path": {"type": "string"}, "content": {"type": "string"}}), &["path", "content"])
    }
    fn access(&self) -> Access {
        Access::Write
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "path").unwrap_or("?").to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let (Some(p), Some(content)) = (str_arg(&input, "path"), str_arg(&input, "content")) else {
                return ToolOutput::err("path and content are required");
            };
            let path = ctx.resolve(p);
            if let Err(e) = check_fresh(ctx, &path) {
                return ToolOutput::err(e);
            }
            let old = tokio::fs::read_to_string(&path).await.ok();
            ctx.before_change(&path);
            if let Some(dir) = path.parent() {
                if let Err(e) = tokio::fs::create_dir_all(dir).await {
                    return ToolOutput::err(format!("cannot create {}: {e}", dir.display()));
                }
            }
            if let Err(e) = tokio::fs::write(&path, content).await {
                return ToolOutput::err(format!("cannot write {p}: {e}"));
            }
            remember(ctx, &path);
            let shown = ctx.display(&path);
            let (d, add, del) = diff(old.as_deref().unwrap_or(""), content, &shown);
            let summary = if old.is_some() { format!("+{add} -{del}") } else { format!("{} lines · new", content.lines().count()) };
            ToolOutput { ok: true, content: vec![ResultPart::Text { text: format!("wrote {shown}") }], summary, display: String::new(), diff: Some(d) }
        })
    }
}

pub struct Edit;

impl Tool for Edit {
    fn name(&self) -> &'static str {
        "edit"
    }
    fn description(&self) -> &'static str {
        "Replace an exact string in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. The file must have been read first."
    }
    fn schema(&self) -> Value {
        schema(
            json!({
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"}
            }),
            &["path", "old_string", "new_string"],
        )
    }
    fn access(&self) -> Access {
        Access::Write
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "path").unwrap_or("?").to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let (Some(p), Some(old_s), Some(new_s)) = (str_arg(&input, "path"), str_arg(&input, "old_string"), str_arg(&input, "new_string")) else {
                return ToolOutput::err("path, old_string and new_string are required");
            };
            let path = ctx.resolve(p);
            if !path.exists() {
                return ToolOutput::err(format!("{p} does not exist; use write to create it"));
            }
            if let Err(e) = check_fresh(ctx, &path) {
                return ToolOutput::err(e);
            }
            let text = match tokio::fs::read_to_string(&path).await {
                Ok(t) => t,
                Err(e) => return ToolOutput::err(format!("cannot read {p}: {e}")),
            };
            let all = input.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
            let (updated, count) = match replace_once(&text, old_s, new_s, all) {
                Ok(r) => r,
                Err(e) => return ToolOutput::err(format!("{p}: {e}")),
            };
            ctx.before_change(&path);
            if let Err(e) = tokio::fs::write(&path, &updated).await {
                return ToolOutput::err(format!("cannot write {p}: {e}"));
            }
            remember(ctx, &path);
            let shown = ctx.display(&path);
            let (d, add, del) = diff(&text, &updated, &shown);
            let msg = if all && count > 1 { format!("edited {shown} ({count} replacements)") } else { format!("edited {shown}") };
            ToolOutput { ok: true, content: vec![ResultPart::Text { text: msg }], summary: format!("+{add} -{del}"), display: String::new(), diff: Some(d) }
        })
    }
}

/// Apply one exact-string replacement in memory: the new text and how many places changed.
pub fn replace_once(text: &str, old_s: &str, new_s: &str, all: bool) -> Result<(String, usize), String> {
    if old_s.is_empty() {
        return Err("old_string is empty".into());
    }
    if old_s == new_s {
        return Err("old_string and new_string are identical".into());
    }
    let count = text.matches(old_s).count();
    if count == 0 {
        return Err("old_string not found; read the file again and copy the text exactly".into());
    }
    if count > 1 && !all {
        return Err(format!("old_string appears {count} times; add surrounding context to make it unique, or set replace_all"));
    }
    Ok((if all { text.replace(old_s, new_s) } else { text.replacen(old_s, new_s, 1) }, if all { count } else { 1 }))
}

pub struct MultiEdit;

impl Tool for MultiEdit {
    fn name(&self) -> &'static str {
        "multi_edit"
    }
    fn description(&self) -> &'static str {
        "Make several exact-string replacements in one file, applied in order. All succeed or none are written. Each edit follows the same rules as edit."
    }
    fn schema(&self) -> Value {
        schema(
            json!({
                "path": {"type": "string"},
                "edits": {"type": "array", "items": {"type": "object", "properties": {
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                    "replace_all": {"type": "boolean"}
                }, "required": ["old_string", "new_string"], "additionalProperties": false}}
            }),
            &["path", "edits"],
        )
    }
    fn access(&self) -> Access {
        Access::Write
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "path").unwrap_or("?").to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(p) = str_arg(&input, "path") else { return ToolOutput::err("path is required") };
            let edits = input.get("edits").and_then(Value::as_array).cloned().unwrap_or_default();
            if edits.is_empty() {
                return ToolOutput::err("edits must be a non-empty array");
            }
            let path = ctx.resolve(p);
            if !path.exists() {
                return ToolOutput::err(format!("{p} does not exist; use write to create it"));
            }
            if let Err(e) = check_fresh(ctx, &path) {
                return ToolOutput::err(e);
            }
            let original = match tokio::fs::read_to_string(&path).await {
                Ok(t) => t,
                Err(e) => return ToolOutput::err(format!("cannot read {p}: {e}")),
            };
            let mut text = original.clone();
            for (i, e) in edits.iter().enumerate() {
                let (o, n) = (str_arg(e, "old_string").unwrap_or(""), str_arg(e, "new_string").unwrap_or(""));
                let all = e.get("replace_all").and_then(Value::as_bool).unwrap_or(false);
                match replace_once(&text, o, n, all) {
                    Ok((t, _)) => text = t,
                    Err(msg) => return ToolOutput::err(format!("edit {} of {}: {msg} (nothing was written)", i + 1, edits.len())),
                }
            }
            ctx.before_change(&path);
            if let Err(e) = tokio::fs::write(&path, &text).await {
                return ToolOutput::err(format!("cannot write {p}: {e}"));
            }
            remember(ctx, &path);
            let shown = ctx.display(&path);
            let (d, add, del) = diff(&original, &text, &shown);
            ToolOutput {
                ok: true,
                content: vec![ResultPart::Text { text: format!("applied {} edits to {shown}", edits.len()) }],
                summary: format!("+{add} -{del}"),
                display: String::new(),
                diff: Some(d),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::{ctx, text};

    #[tokio::test]
    async fn read_then_edit() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "one\ntwo\ntwo\n").unwrap();
        let (c, _rx) = ctx(dir.path());

        let e = Edit.run(&c, json!({"path":"a.ts","old_string":"one","new_string":"1"})).await;
        assert!(!e.ok && text(&e).contains("has not been read"));

        let r = Read.run(&c, json!({"path":"a.ts"})).await;
        assert_eq!(r.summary, "3 lines");
        let empty = Edit.run(&c, json!({"path":"a.ts","old_string":"","new_string":"x","replace_all":true})).await;
        assert!(!empty.ok && text(&empty).contains("old_string is empty"), "never an insert between every character");
        assert!(text(&r).contains("     1\tone"));

        let dup = Edit.run(&c, json!({"path":"a.ts","old_string":"two","new_string":"2"})).await;
        assert!(!dup.ok && text(&dup).contains("appears 2 times"));

        let ok = Edit.run(&c, json!({"path":"a.ts","old_string":"one","new_string":"1"})).await;
        assert!(ok.ok, "{}", text(&ok));
        assert_eq!(ok.summary, "+1 -1");
        assert!(ok.diff.unwrap().contains("-one\n+1"));

        let all = Edit.run(&c, json!({"path":"a.ts","old_string":"two","new_string":"2","replace_all":true})).await;
        assert!(all.ok);
        assert_eq!(std::fs::read_to_string(dir.path().join("a.ts")).unwrap(), "1\n2\n2\n");
    }

    #[tokio::test]
    async fn multi_edit_is_all_or_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("m.ts"), "a\nb\nc\n").unwrap();
        let (c, _rx) = ctx(dir.path());
        Read.run(&c, json!({"path":"m.ts"})).await;
        let bad = MultiEdit.run(&c, json!({"path":"m.ts","edits":[{"old_string":"a","new_string":"A"},{"old_string":"zzz","new_string":"Z"}]})).await;
        assert!(!bad.ok && text(&bad).contains("edit 2 of 2"));
        assert_eq!(std::fs::read_to_string(dir.path().join("m.ts")).unwrap(), "a\nb\nc\n");
        let ok = MultiEdit.run(&c, json!({"path":"m.ts","edits":[{"old_string":"a","new_string":"A"},{"old_string":"c","new_string":"C"}]})).await;
        assert!(ok.ok && ok.summary == "+2 -2");
        assert_eq!(std::fs::read_to_string(dir.path().join("m.ts")).unwrap(), "A\nb\nC\n");
    }

    #[tokio::test]
    async fn stale_reads_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("b.txt");
        std::fs::write(&f, "x").unwrap();
        let (c, _rx) = ctx(dir.path());
        Read.run(&c, json!({"path":"b.txt"})).await;
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&f, "changed elsewhere").unwrap();
        let e = Edit.run(&c, json!({"path":"b.txt","old_string":"changed","new_string":"y"})).await;
        assert!(!e.ok && text(&e).contains("changed on disk"));
    }

    #[tokio::test]
    async fn write_creates_and_requires_read_to_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let (c, _rx) = ctx(dir.path());
        let w = Write.run(&c, json!({"path":"src/new.rs","content":"fn main() {}\n"})).await;
        assert!(w.ok && w.summary == "1 lines · new");
        // Written by us, so overwriting is allowed without a separate read.
        let w2 = Write.run(&c, json!({"path":"src/new.rs","content":"fn main() { }\n"})).await;
        assert!(w2.ok && w2.summary == "+1 -1");
        std::fs::write(dir.path().join("other.txt"), "x").unwrap();
        assert!(!Write.run(&c, json!({"path":"other.txt","content":"y"})).await.ok);
    }
}
