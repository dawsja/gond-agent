//! Parser-backed navigation via Universal Ctags; references are explicitly lexical, not LSP results.
use std::path::{Path, PathBuf};
use futures::future::BoxFuture;
use ignore::WalkBuilder;
use serde_json::{Value, json};
use tokio::process::Command;

use super::{Tool, ToolCtx, ToolOutput, clip, schema, str_arg};
use crate::permissions::Access;

pub struct Symbols;
const MAX_FILES: usize = 5000;
const MAX_FILE_SIZE: u64 = 1_000_000;

fn files(root: &Path) -> Vec<PathBuf> {
    WalkBuilder::new(root).hidden(true).git_ignore(true).sort_by_file_path(|a, b| a.cmp(b))
        .filter_entry(|e| !matches!(e.file_name().to_str(), Some("node_modules" | "target" | "dist" | ".git" | "vendor")))
        .build().filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()) && e.metadata().is_ok_and(|m| m.len() <= MAX_FILE_SIZE))
        .map(|e| e.into_path()).take(MAX_FILES + 1).collect()
}

impl Tool for Symbols {
    fn name(&self) -> &'static str { "symbols" }
    fn description(&self) -> &'static str {
        "Navigate code: outline lists a file's declarations; definitions finds exact named declarations using Universal Ctags. references finds whole-identifier lexical occurrences (including comments/strings, not semantic references). Results include path:line, kind and scope. Respects ignore files; narrow large searches with path."
    }
    fn schema(&self) -> Value {
        schema(json!({
            "action":{"type":"string","enum":["outline","definitions","references"]},
            "path":{"type":"string","description":"File or directory; outline requires a file"},
            "symbol":{"type":"string","description":"Exact symbol name; required except for outline"},
            "limit":{"type":"integer","minimum":1,"maximum":200}
        }), &["action"])
    }
    fn access(&self) -> Access { Access::Read }
    fn title(&self, input: &Value) -> String {
        format!("{} {} in {}", str_arg(input,"action").unwrap_or("?"), str_arg(input,"symbol").unwrap_or(""), str_arg(input,"path").unwrap_or("."))
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let action = str_arg(&input, "action").unwrap_or("");
            if !matches!(action, "outline" | "definitions" | "references") { return ToolOutput::err("Unknown symbols action"); }
            let symbol = str_arg(&input,"symbol").unwrap_or("");
            if action != "outline" && (symbol.is_empty() || symbol.len() > 256) { return ToolOutput::err("symbol must contain 1-256 bytes"); }
            let root = ctx.resolve(str_arg(&input,"path").unwrap_or("."));
            if !root.exists() { return ToolOutput::err("Search path does not exist"); }
            if action == "outline" && !root.is_file() { return ToolOutput::err("outline requires a file path"); }
            let paths = tokio::task::spawn_blocking(move || files(&root)).await.unwrap_or_default();
            if paths.len() > MAX_FILES { return ToolOutput::err("More than 5000 files; narrow path before navigating symbols"); }
            let limit = input["limit"].as_u64().unwrap_or(100).clamp(1,200) as usize;
            if action == "references" {
                let re = regex::Regex::new(&format!(r"(?:^|[^\p{{L}}\p{{N}}_$]){}(?:$|[^\p{{L}}\p{{N}}_$])", regex::escape(symbol))).unwrap();
                let cwd = ctx.cwd.clone();
                let (rows, more) = tokio::task::spawn_blocking(move || {
                    let mut rows = Vec::new();
                    for path in paths {
                        let Ok(bytes) = std::fs::read(&path) else { continue };
                        let Ok(text) = std::str::from_utf8(&bytes) else { continue };
                        for (line, text) in text.lines().enumerate() {
                            if re.is_match(text) {
                                if rows.len() == limit { return (rows, true); }
                                rows.push(format!("{}:{}: {}", super::slashes(path.strip_prefix(&cwd).unwrap_or(&path).display().to_string()), line + 1, text.trim().chars().take(300).collect::<String>()));
                            }
                        }
                    }
                    (rows, false)
                }).await.unwrap_or_default();
                return navigation_output(rows, more, "lexical occurrences (not semantic references)");
            }
            if paths.is_empty() { return navigation_output(vec![], false, "symbols"); }
            let mut list = String::new();
            for path in paths {
                let Some(path) = path.to_str().filter(|p| !p.contains(['\n','\r'])) else { return ToolOutput::err("Unsupported filename for symbol navigation"); };
                list.push_str(path); list.push('\n');
            }
            let mut cmd = Command::new("ctags");
            cmd.args(["--options=NONE", "--output-format=json", "--fields=+neK", "--extras=-F", "--sort=no", "-f", "-", "-L", "-"]);
            let bytes = match super::process::capture(ctx, cmd, list.into_bytes(), 4_000_000, 30).await {
                Ok(b) => b,
                Err(e) => return ToolOutput::err(e),
            };
            let mut rows = Vec::new();
            let mut more = false;
            for line in bytes.split(|b| *b == b'\n') {
                let Ok(tag) = serde_json::from_slice::<Value>(line) else { continue };
                if tag["_type"] != "tag" || (action == "definitions" && tag["name"] != symbol) { continue; }
                if rows.len() == limit { more = true; break; }
                rows.push(format!("{}:{}: {} {}{}", ctx.display(Path::new(tag["path"].as_str().unwrap_or("?"))), tag["line"], tag["kind"].as_str().unwrap_or("symbol"), tag["name"].as_str().unwrap_or("?"), tag["scope"].as_str().map(|s| format!(" (in {s})")).unwrap_or_default()));
            }
            navigation_output(rows, more, "symbols")
        })
    }
}

fn navigation_output(rows: Vec<String>, more: bool, kind: &str) -> ToolOutput {
    let summary = format!("{}{} {kind}", rows.len(), if more { "+" } else { "" });
    let mut text = if rows.is_empty() { "No matches".into() } else { rows.join("\n") };
    if more { text.push_str("\n… results truncated; narrow path or symbol"); }
    ToolOutput::ok(clip(&text, 30_000), summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::{ctx, text};

    #[tokio::test]
    async fn lexical_references_have_boundaries_and_limits() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a.ts"), "foo()\nfoobar()\n$foo()\n// foo\nfoo()\n").unwrap();
        let (c, _rx) = ctx(d.path());
        let out = Symbols.run(&c, json!({"action":"references","symbol":"foo","limit":2})).await;
        assert!(out.ok);
        assert!(text(&out).contains("a.ts:1:") && text(&out).contains("a.ts:4:"));
        assert!(!text(&out).contains("a.ts:2:") && !text(&out).contains("a.ts:3:"));
        assert!(text(&out).contains("truncated"));
        assert!(out.summary.contains("not semantic"));
        assert!(!Symbols.run(&c, json!({"action":"outline"})).await.ok);
    }
}
