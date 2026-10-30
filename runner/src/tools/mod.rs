//! Built-in tools. Each tool declares its schema, its access level (for permissions), and how it
//! renders in the transcript. Agent-level tools (todo_write, ask_user, task) live in agent/core.rs.

pub mod bash;
pub mod batch;
pub mod browser;
pub mod fs;
pub mod patch;
pub(crate) mod process;
pub mod search;
pub mod symbols;
pub mod web;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use crate::agent::events::AgentEvent;
use crate::api::wire::{ResultPart, ToolDef};
use crate::permissions::Access;

/// Files read in this session and their mtime at read time: edit/write require a fresh read.
pub type ReadSet = Arc<Mutex<HashMap<PathBuf, Option<SystemTime>>>>;

/// Background shells started with `bash` + run_in_background, by id.
pub type Shells = Arc<Mutex<HashMap<String, bash::BgShell>>>;

/// What each file looked like before this session first changed it with an edit tool (None: it didn't
/// exist). Used to track edits inside the workspace container.
pub type Baseline = Arc<Mutex<HashMap<PathBuf, Option<Vec<u8>>>>>;

pub struct ToolCtx {
    pub cwd: PathBuf,
    pub agent_id: String,
    pub call_id: String,
    pub events: UnboundedSender<AgentEvent>,
    pub reads: ReadSet,
    pub shells: Shells,
    pub baseline: Baseline,
    pub cancel: tokio_util::sync::CancellationToken,
}

impl ToolCtx {
    pub fn resolve(&self, p: &str) -> PathBuf {
        let p = Path::new(p);
        if p.is_absolute() { p.to_path_buf() } else { self.cwd.join(p) }
    }
    /// Path as shown to the user: relative to cwd when inside it, with forward slashes on every platform.
    pub fn display(&self, p: &Path) -> String {
        slashes(p.strip_prefix(&self.cwd).unwrap_or(p).display().to_string())
    }
    /// Call before an edit tool changes `path`: remembers its contents the first time.
    pub fn before_change(&self, path: &Path) {
        let mut b = self.baseline.lock().unwrap();
        if !b.contains_key(path) {
            b.insert(path.to_path_buf(), std::fs::read(path).ok());
        }
    }
    pub fn output(&self, chunk: String) {
        let _ = self.events.send(AgentEvent::ToolOutput { agent_id: self.agent_id.clone(), call_id: self.call_id.clone(), chunk });
    }
}

#[derive(Debug, Clone, Default)]
pub struct ToolOutput {
    pub ok: bool,
    /// What the model receives.
    pub content: Vec<ResultPart>,
    /// Short status shown after the title: `84 lines`, `exit 1 · 2.3s`, `+5 -1`.
    pub summary: String,
    /// Output shown in the transcript (the UI truncates further).
    pub display: String,
    pub diff: Option<String>,
}

impl ToolOutput {
    pub fn ok(text: impl Into<String>, summary: impl Into<String>) -> Self {
        let text = text.into();
        ToolOutput { ok: true, display: text.clone(), content: vec![ResultPart::Text { text }], summary: summary.into(), diff: None }
    }
    pub fn err(text: impl Into<String>) -> Self {
        let text = text.into();
        ToolOutput { ok: false, display: text.clone(), summary: "error".into(), content: vec![ResultPart::Text { text }], diff: None }
    }
}

pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn description(&self) -> &'static str;
    fn schema(&self) -> Value;
    fn access(&self) -> Access;
    /// One-line title for the transcript bullet, e.g. the path or the command.
    fn title(&self, input: &Value) -> String;
    /// The string permission rules match against (command for bash, path for file tools).
    fn target(&self, input: &Value) -> String {
        self.title(input)
    }
    /// The files a call writes, as the model gave them (for the outside-the-folder check).
    fn paths(&self, input: &Value) -> Vec<String> {
        str_arg(input, "path").map(|p| vec![p.to_owned()]).unwrap_or_default()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput>;

    fn def(&self) -> ToolDef {
        ToolDef { name: self.name().into(), description: self.description().into(), input_schema: self.schema() }
    }
}

pub fn builtin() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(fs::Read),
        Arc::new(fs::Write),
        Arc::new(fs::Edit),
        Arc::new(fs::MultiEdit),
        Arc::new(patch::ApplyPatch),
        Arc::new(search::ListDir),
        Arc::new(search::Glob),
        Arc::new(search::Grep),
        Arc::new(symbols::Symbols),
        Arc::new(batch::Batch),
        Arc::new(browser::Browser),
        Arc::new(bash::Bash),
        Arc::new(bash::BashOutput),
        Arc::new(bash::KillShell),
        Arc::new(web::WebFetch),
    ]
}

/// `p` as the file system sees it: each existing part resolved in order (links, including ones whose
/// target doesn't exist yet, and Windows' short names like `RUNNER~1`), so `..` applies to where a link
/// really leads. Parts that don't exist yet are kept as written.
pub fn real(p: &Path) -> PathBuf {
    real_at(p, 0)
}

fn real_at(p: &Path, depth: u32) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    // Whether `out` exists so far: past the first missing part nothing can be a link.
    let mut exists = true;
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => {
                let next = out.join(name);
                if exists {
                    match std::fs::symlink_metadata(&next) {
                        Ok(m) if m.file_type().is_symlink() && depth < 40 => {
                            if let Ok(target) = std::fs::read_link(&next) {
                                out = real_at(&out.join(target), depth + 1);
                                continue;
                            }
                            out = next;
                        }
                        Ok(_) => out = next,
                        Err(_) => {
                            exists = false;
                            out = next;
                        }
                    }
                } else {
                    out = next;
                }
            }
            c => out.push(c),
        }
    }
    // Canonical spelling for the part that exists (Windows short names, `\\?\` like the rest).
    let mut rest: Vec<std::ffi::OsString> = vec![];
    let mut cur = out.as_path();
    loop {
        if let Ok(r) = cur.canonicalize() {
            return rest.iter().rev().fold(r, |acc, c| acc.join(c));
        }
        match (cur.parent(), cur.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_owned());
                cur = parent;
            }
            _ => return out,
        }
    }
}

/// A path without Windows' `\\?\` (or `\\?\UNC\`) prefix, which canonical paths carry and the model's don't.
pub fn plain(p: &Path) -> String {
    let s = p.display().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or(s)
}

/// The parts of `path` (relative to `cwd`, or absolute) below `cwd`, both resolved by `real`, or None
/// when it lands outside. Letter case doesn't matter on Windows.
fn below(cwd: &Path, path: &str) -> Option<Vec<String>> {
    let parts = |p: &Path| -> Vec<String> { Path::new(&plain(p)).components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect() };
    let (base, full) = (parts(&real(cwd)), parts(&real(&cwd.join(path))));
    let same = |a: &String, b: &String| if cfg!(windows) { a.eq_ignore_ascii_case(b) } else { a == b };
    if full.len() < base.len() || !base.iter().zip(&full).all(|(a, b)| same(a, b)) {
        return None;
    }
    Some(full[base.len()..].to_vec())
}

/// Whether `path` (relative to `cwd`, or absolute) lands outside `cwd`, following `..` and links.
#[cfg(test)]
fn outside(cwd: &Path, path: &str) -> bool {
    below(cwd, path).is_none()
}

/// The path "always allow" rules see for a file a tool writes: inside `cwd`, relative to it with `/`.
/// None outside the folder and inside `.git` or `.gond-agent` (hooks and the folder's own settings), where
/// rules never apply.
pub fn rule_path(cwd: &Path, path: &str) -> Option<String> {
    let parts = below(cwd, path)?;
    for p in &parts {
        let base = p.split(':').next().unwrap_or(p).trim_end_matches(['.', ' ']).to_ascii_lowercase();
        if matches!(base.as_str(), ".git" | ".gond-agent") || p.contains(':') {
            return None;
        }
    }
    Some(parts.join("/"))
}

pub fn slashes(s: String) -> String {
    if cfg!(windows) { s.replace('\\', "/") } else { s }
}

pub fn str_arg<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

pub fn schema(props: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

/// One-line JSON for titles, truncated.
pub fn compact_json(v: &Value, max: usize) -> String {
    let s = serde_json::to_string(v).unwrap_or_default();
    if s.chars().count() <= max { s } else { s.chars().take(max.saturating_sub(1)).collect::<String>() + "…" }
}

/// Keep the head and tail of long output.
pub fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let head = floor_char(s, max * 2 / 3);
    let tail_start = ceil_char(s, s.len() - (max - head));
    let omitted = s[head..tail_start].lines().count();
    format!("{}\n… {omitted} lines omitted …\n{}", &s[..head], &s[tail_start..])
}

pub(crate) fn floor_char(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}
fn ceil_char(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
pub mod testutil {
    use super::*;

    pub fn ctx(dir: &Path) -> (ToolCtx, tokio::sync::mpsc::UnboundedReceiver<AgentEvent>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            ToolCtx {
                cwd: dir.to_path_buf(),
                agent_id: "main".into(),
                call_id: "c1".into(),
                events: tx,
                reads: Default::default(),
                shells: Default::default(),
                baseline: Default::default(),
                cancel: Default::default(),
            },
            rx,
        )
    }

    pub fn text(o: &ToolOutput) -> String {
        o.content.iter().filter_map(|p| if let ResultPart::Text { text } = p { Some(text.as_str()) } else { None }).collect()
    }

    /// A tiny HTTP/1.1 server on 127.0.0.1 for tests: each request (one per connection) goes to `handler`.
    pub mod http {
        use std::sync::Arc;

        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        pub struct Req {
            /// The request line and headers, lowercased.
            pub head: String,
            pub body: Vec<u8>,
        }

        impl Req {
            pub fn header(&self, name: &str) -> Option<String> {
                self.head.lines().find_map(|l| l.strip_prefix(&format!("{name}:"))).map(|v| v.trim().to_owned())
            }
            pub fn json(&self) -> serde_json::Value {
                serde_json::from_slice(&self.body).unwrap_or(serde_json::Value::Null)
            }
        }

        pub struct Res {
            pub status: u16,
            pub content_type: String,
            /// Extra header lines, each ending in `\r\n`.
            pub headers: String,
            pub body: Vec<u8>,
        }

        impl Res {
            pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Res {
                Res { status, content_type: content_type.into(), headers: String::new(), body: body.into() }
            }
        }

        /// Serves until the test ends; returns `http://127.0.0.1:<port>`.
        pub async fn serve(handler: impl Fn(Req) -> Res + Send + Sync + 'static) -> String {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let handler = Arc::new(handler);
            tokio::spawn(async move {
                while let Ok((mut sock, _)) = listener.accept().await {
                    let handler = handler.clone();
                    tokio::spawn(async move {
                        let (mut buf, mut tmp) = (Vec::new(), [0u8; 4096]);
                        let start = loop {
                            let n = sock.read(&mut tmp).await.unwrap_or(0);
                            if n == 0 {
                                return;
                            }
                            buf.extend_from_slice(&tmp[..n]);
                            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                break i + 4;
                            }
                        };
                        let head = String::from_utf8_lossy(&buf[..start]).to_lowercase();
                        let len: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                        while buf.len() < start + len {
                            let n = sock.read(&mut tmp).await.unwrap_or(0);
                            if n == 0 {
                                return;
                            }
                            buf.extend_from_slice(&tmp[..n]);
                        }
                        let res = handler(Req { body: buf[start..start + len].to_vec(), head });
                        let ctype = if res.content_type.is_empty() { String::new() } else { format!("content-type: {}\r\n", res.content_type) };
                        let head = format!("HTTP/1.1 {} X\r\n{ctype}{}content-length: {}\r\nconnection: close\r\n\r\n", res.status, res.headers, res.body.len());
                        let _ = sock.write_all(head.as_bytes()).await;
                        let _ = sock.write_all(&res.body).await;
                    });
                }
            });
            format!("http://{addr}")
        }
    }


    #[test]
    fn outside_follows_dotdot_and_absolute_paths() {
        let cwd = std::env::temp_dir().join("proj");
        assert!(!outside(&cwd, "src/a.ts"));
        assert!(!outside(&cwd, "src/../a.ts"));
        assert!(outside(&cwd, "../a.ts"));
        assert!(outside(&cwd, "src/../../a.ts"));
        assert!(!outside(&cwd, cwd.join("a.ts").to_str().unwrap()));
        assert!(outside(&cwd, std::env::temp_dir().join("projX/a.ts").to_str().unwrap()), "a sibling with the same prefix is outside");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rules_see_real_paths_inside_the_folder_only() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().join("proj");
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        assert_eq!(rule_path(&cwd, "src/a.ts").as_deref(), Some("src/a.ts"));
        assert_eq!(rule_path(&cwd, "./src/new/b.ts").as_deref(), Some("src/new/b.ts"));
        assert_eq!(rule_path(&cwd, "src/../../.bashrc"), None, "a glob like src/** can't reach outside");
        assert_eq!(rule_path(&cwd, ".git/hooks/pre-commit"), None);
        assert_eq!(rule_path(&cwd, "sub/.git/hooks/pre-commit"), None);
        assert_eq!(rule_path(&cwd, ".gond-agent./settings.json"), None);
        assert_eq!(rule_path(&cwd, "src/../.gond-agent/settings.json"), None);
        assert_eq!(rule_path(&cwd, dir.path().join("x").to_str().unwrap()), None);
    }

    #[cfg(unix)]
    #[test]
    fn links_are_followed_before_dotdot() {
        let dir = tempfile::tempdir().unwrap();
        let (cwd, away) = (dir.path().join("proj"), dir.path().join("away/deep"));
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(&away).unwrap();
        std::os::unix::fs::symlink(&away, cwd.join("link")).unwrap();
        // link/.. is away/, not the folder.
        assert!(outside(&cwd, "link/../x"));
        assert!(outside(&cwd, "link/file"));
        // A link whose target doesn't exist yet: writing through it would create the file outside.
        std::os::unix::fs::symlink(dir.path().join("away/new.txt"), cwd.join("dangling")).unwrap();
        assert!(outside(&cwd, "dangling"));
        assert!(!outside(&cwd, "fine/../ok.txt"));
    }
}
