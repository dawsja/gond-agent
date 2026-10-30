use std::path::PathBuf;

use futures::future::BoxFuture;
use ignore::WalkBuilder;
use serde_json::{Value, json};

use super::{Tool, ToolCtx, ToolOutput, clip, schema, str_arg};
use crate::permissions::Access;

const MAX_FILES: usize = 200;
const MAX_MATCHES: usize = 300;
const MAX_OUTPUT: usize = 30_000;

/// Files under `root`, respecting .gitignore/.ignore, skipping hidden files and .git.
fn walk(root: &PathBuf) -> impl Iterator<Item = PathBuf> {
    WalkBuilder::new(root)
        .hidden(true)
        .git_ignore(true)
        .git_global(true)
        .build()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .map(|e| e.into_path())
}

pub struct ListDir;

impl Tool for ListDir {
    fn name(&self) -> &'static str {
        "list_directory"
    }
    fn description(&self) -> &'static str {
        "List a directory as a tree (directories end with /), respecting .gitignore. depth defaults to 2."
    }
    fn schema(&self) -> Value {
        schema(json!({"path": {"type": "string"}, "depth": {"type": "integer", "description": "1-6"}}), &[])
    }
    fn access(&self) -> Access {
        Access::Read
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "path").unwrap_or(".").to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let root = ctx.resolve(str_arg(&input, "path").unwrap_or("."));
            if !root.is_dir() {
                return ToolOutput::err(format!("{} is not a directory", ctx.display(&root)));
            }
            let depth = input.get("depth").and_then(Value::as_u64).unwrap_or(2).clamp(1, 6) as usize;
            let root2 = root.clone();
            let (lines, total) = tokio::task::spawn_blocking(move || {
                let mut lines = Vec::new();
                let mut total = 0usize;
                for e in WalkBuilder::new(&root2).hidden(true).git_ignore(true).max_depth(Some(depth)).sort_by_file_name(|a, b| a.cmp(b)).build().filter_map(Result::ok) {
                    if e.depth() == 0 {
                        continue;
                    }
                    total += 1;
                    if lines.len() < MAX_FILES * 2 {
                        let name = e.file_name().to_string_lossy();
                        let dir = e.file_type().is_some_and(|t| t.is_dir());
                        lines.push(format!("{}{}{}", "  ".repeat(e.depth() - 1), name, if dir { "/" } else { "" }));
                    }
                }
                (lines, total)
            })
            .await
            .unwrap_or_default();
            let mut text = if lines.is_empty() { "(empty)".to_owned() } else { lines.join("\n") };
            if total > lines.len() {
                text.push_str(&format!("\n… {} more entries", total - lines.len()));
            }
            ToolOutput::ok(text, format!("{total} entries"))
        })
    }
}

pub struct Glob;

impl Tool for Glob {
    fn name(&self) -> &'static str {
        "glob"
    }
    fn description(&self) -> &'static str {
        "Find files by glob pattern (e.g. \"src/**/*.ts\"), respecting .gitignore. Results are sorted by modification time, newest first."
    }
    fn schema(&self) -> Value {
        schema(
            json!({"pattern": {"type": "string"}, "path": {"type": "string", "description": "Directory to search (default: working directory)"}}),
            &["pattern"],
        )
    }
    fn access(&self) -> Access {
        Access::Read
    }
    fn title(&self, input: &Value) -> String {
        let p = str_arg(input, "pattern").unwrap_or("?");
        match str_arg(input, "path") {
            Some(d) => format!("{p} in {d}"),
            None => p.to_owned(),
        }
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(pattern) = str_arg(&input, "pattern") else { return ToolOutput::err("pattern is required") };
            let matcher = match globset::GlobBuilder::new(pattern).literal_separator(false).build() {
                Ok(g) => g.compile_matcher(),
                Err(e) => return ToolOutput::err(format!("bad glob: {e}")),
            };
            let root = ctx.resolve(str_arg(&input, "path").unwrap_or("."));
            let root2 = root.clone();
            let mut found: Vec<(PathBuf, std::time::SystemTime)> = tokio::task::spawn_blocking(move || {
                walk(&root2)
                    .filter(|p| p.strip_prefix(&root2).is_ok_and(|rel| matcher.is_match(rel)))
                    .map(|p| {
                        let t = std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                        (p, t)
                    })
                    .collect()
            })
            .await
            .unwrap_or_default();
            found.sort_by_key(|f| std::cmp::Reverse(f.1));
            let total = found.len();
            let mut out: Vec<String> = found.iter().take(MAX_FILES).map(|(p, _)| ctx.display(p)).collect();
            if total > MAX_FILES {
                out.push(format!("… {} more", total - MAX_FILES));
            }
            let text = if out.is_empty() { "no files matched".to_owned() } else { out.join("\n") };
            ToolOutput::ok(text, format!("{total} files"))
        })
    }
}

pub struct Grep;

impl Tool for Grep {
    fn name(&self) -> &'static str {
        "grep"
    }
    fn description(&self) -> &'static str {
        "Search file contents with a regular expression, respecting .gitignore. output_mode \"files\" (default) lists matching files; \"content\" shows matching lines as path:line: text."
    }
    fn schema(&self) -> Value {
        schema(
            json!({
                "pattern": {"type": "string", "description": "Rust regex syntax"},
                "path": {"type": "string", "description": "File or directory (default: working directory)"},
                "glob": {"type": "string", "description": "Only search files matching this glob, e.g. \"*.ts\""},
                "case_insensitive": {"type": "boolean"},
                "output_mode": {"type": "string", "enum": ["files", "content"]}
            }),
            &["pattern"],
        )
    }
    fn access(&self) -> Access {
        Access::Read
    }
    fn title(&self, input: &Value) -> String {
        let p = str_arg(input, "pattern").unwrap_or("?");
        let mut t = format!("\"{p}\"");
        if let Some(d) = str_arg(input, "path") {
            t.push_str(&format!(" in {d}"));
        }
        if let Some(g) = str_arg(input, "glob") {
            t.push_str(&format!(" ({g})"));
        }
        t
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(pattern) = str_arg(&input, "pattern") else { return ToolOutput::err("pattern is required") };
            let ci = input.get("case_insensitive").and_then(Value::as_bool).unwrap_or(false);
            let re = match regex::RegexBuilder::new(pattern).case_insensitive(ci).build() {
                Ok(r) => r,
                Err(e) => return ToolOutput::err(format!("bad regex: {e}")),
            };
            let glob = match str_arg(&input, "glob").map(globset::Glob::new).transpose() {
                Ok(g) => g.map(|g| g.compile_matcher()),
                Err(e) => return ToolOutput::err(format!("bad glob: {e}")),
            };
            let content_mode = str_arg(&input, "output_mode") == Some("content");
            let root = ctx.resolve(str_arg(&input, "path").unwrap_or("."));
            let cwd = ctx.cwd.clone();
            let (lines, files, matches) = tokio::task::spawn_blocking(move || {
                let mut lines = Vec::new();
                let (mut files, mut matches) = (0usize, 0usize);
                let paths: Box<dyn Iterator<Item = PathBuf>> =
                    if root.is_file() { Box::new(std::iter::once(root.clone())) } else { Box::new(walk(&root)) };
                for p in paths {
                    if let Some(g) = &glob {
                        let name = p.file_name().map(PathBuf::from).unwrap_or_default();
                        if !g.is_match(&name) && !g.is_match(p.strip_prefix(&root).unwrap_or(&p)) {
                            continue;
                        }
                    }
                    let Ok(bytes) = std::fs::read(&p) else { continue };
                    if bytes.iter().take(8000).any(|&b| b == 0) {
                        continue; // binary
                    }
                    let text = String::from_utf8_lossy(&bytes);
                    let shown = super::slashes(p.strip_prefix(&cwd).unwrap_or(&p).display().to_string());
                    let mut hit = false;
                    for (i, line) in text.lines().enumerate() {
                        if re.is_match(line) {
                            hit = true;
                            matches += 1;
                            if content_mode && matches <= MAX_MATCHES {
                                let l: String = line.chars().take(300).collect();
                                lines.push(format!("{shown}:{}: {}", i + 1, l.trim_end()));
                            }
                            if !content_mode {
                                break;
                            }
                        }
                    }
                    if hit {
                        files += 1;
                        if !content_mode && files <= MAX_FILES {
                            lines.push(shown);
                        }
                    }
                }
                (lines, files, matches)
            })
            .await
            .unwrap_or_default();
            let summary = if content_mode { format!("{matches} matches in {files} files") } else { format!("{files} files") };
            let mut text = if lines.is_empty() { "no matches".to_owned() } else { lines.join("\n") };
            if content_mode && matches > MAX_MATCHES {
                text.push_str(&format!("\n… {} more matches", matches - MAX_MATCHES));
            } else if !content_mode && files > MAX_FILES {
                text.push_str(&format!("\n… {} more files", files - MAX_FILES));
            }
            ToolOutput::ok(clip(&text, MAX_OUTPUT), summary)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::{ctx, text};

    #[tokio::test]
    async fn glob_and_grep_respect_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::create_dir_all(d.join("src/mw")).unwrap();
        std::fs::create_dir_all(d.join("node_modules/x")).unwrap();
        std::fs::write(d.join(".gitignore"), "node_modules\n").unwrap();
        std::fs::write(d.join("src/mw/auth.ts"), "export const auth = () => {}\napp.use(auth)\n").unwrap();
        std::fs::write(d.join("src/index.ts"), "app.use(cors)\n").unwrap();
        std::fs::write(d.join("node_modules/x/i.ts"), "app.use(x)\n").unwrap();
        // ignore only honors .gitignore inside a git repo
        std::fs::create_dir(d.join(".git")).unwrap();
        let (c, _rx) = ctx(d);

        let g = Glob.run(&c, json!({"pattern":"**/*.ts"})).await;
        assert_eq!(g.summary, "2 files");
        assert!(!text(&g).contains("node_modules"));

        let tree = ListDir.run(&c, json!({})).await;
        assert!(text(&tree).contains("src/\n  index.ts\n  mw/"), "{}", text(&tree));
        assert!(!text(&tree).contains("node_modules"));

        let files = Grep.run(&c, json!({"pattern":"app\\.use\\("})).await;
        assert_eq!(files.summary, "2 files");
        let content = Grep.run(&c, json!({"pattern":"app\\.use","output_mode":"content","glob":"auth.ts"})).await;
        assert_eq!(content.summary, "1 matches in 1 files");
        assert!(text(&content).contains("src/mw/auth.ts:2: app.use(auth)"));
    }
}
