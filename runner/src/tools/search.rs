use std::path::PathBuf;
use std::io::{BufRead, BufReader, Read};
use std::collections::VecDeque;

use futures::future::BoxFuture;
use ignore::WalkBuilder;
use serde_json::{Value, json};

use super::{Tool, ToolCtx, ToolOutput, schema, str_arg};
use crate::permissions::Access;

const MAX_FILES: usize = 200;
const MAX_MATCHES: usize = 300;
const MULTILINE_BYTES: u64 = 8 * 1024 * 1024;

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
                text.push_str(&format!("\n… {} more entries; use a narrower path or smaller depth to get more", total - lines.len()));
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
                out.push(format!("… {} more; narrow pattern/path to get more", total - MAX_FILES));
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
        "Search file contents with a regular expression, respecting .gitignore. files mode lists paths, content shows numbered lines with optional context, count gives per-file counts. Use offset/head_limit to page results."
    }
    fn schema(&self) -> Value {
        schema(
            json!({
                "pattern": {"type": "string", "description": "Rust regex syntax"},
                "path": {"type": "string", "description": "File or directory (default: working directory)"},
                "glob": {"type": "string", "description": "Only search files matching this glob, e.g. \"*.ts\""},
                "case_insensitive": {"type": "boolean"},
                "output_mode": {"type": "string", "enum": ["files", "content", "count"]},
                "context_before": {"type":"integer", "minimum":0,"maximum":100},
                "context_after": {"type":"integer", "minimum":0,"maximum":100},
                "context": {"type":"integer", "minimum":0,"maximum":100},
                "head_limit": {"type":"integer", "minimum":1,"maximum":300},
                "offset": {"type":"integer", "minimum":0},
                "multiline": {"type":"boolean", "description":"Match across lines; files over 8 MiB are rejected in this mode"}
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
            let multiline = input["multiline"].as_bool().unwrap_or(false);
            let re = match regex::RegexBuilder::new(pattern).case_insensitive(ci).multi_line(multiline).dot_matches_new_line(multiline).build() {
                Ok(r) => r,
                Err(e) => return ToolOutput::err(format!("bad regex: {e}")),
            };
            let glob = match str_arg(&input, "glob").map(globset::Glob::new).transpose() {
                Ok(g) => g.map(|g| g.compile_matcher()),
                Err(e) => return ToolOutput::err(format!("bad glob: {e}")),
            };
            let mode = str_arg(&input, "output_mode").unwrap_or("files").to_owned();
            if !["files", "content", "count"].contains(&mode.as_str()) { return ToolOutput::err("output_mode must be files, content or count"); }
            let offset = input["offset"].as_u64().unwrap_or(0) as usize;
            let limit = input["head_limit"].as_u64().unwrap_or(MAX_MATCHES as u64).clamp(1, MAX_MATCHES as u64) as usize;
            let context = input["context"].as_u64().unwrap_or(0).min(100) as usize;
            let before = input["context_before"].as_u64().map_or(context, |v| v.min(100) as usize);
            let after = input["context_after"].as_u64().map_or(context, |v| v.min(100) as usize);
            let root = ctx.resolve(str_arg(&input, "path").unwrap_or("."));
            let cwd = ctx.cwd.clone();
            let cancel = ctx.cancel.clone();
            let mut spill = super::output::Spill::new(ctx).ok();
            let result = tokio::task::spawn_blocking(move || -> Result<_, String> {
                let mut lines = Vec::new();
                let (mut files, mut matches, mut rows) = (0usize, 0usize, 0usize);
                let mut output_bytes = 0;
                let mut emit = |row: String| {
                    output_bytes += row.len() + 1;
                    if let Some(s) = &mut spill {
                        if s.push(row.as_bytes()).and_then(|_| s.push(b"\n")).is_err() { spill = None; }
                    }
                    if rows >= offset && rows - offset < limit { lines.push(row); }
                    rows += 1;
                };
                let paths: Box<dyn Iterator<Item = PathBuf>> =
                    if root.is_file() { Box::new(std::iter::once(root.clone())) } else { Box::new(walk(&root)) };
                for p in paths {
                    if cancel.is_cancelled() { return Err("interrupted".into()); }
                    if let Some(g) = &glob {
                        let name = p.file_name().map(PathBuf::from).unwrap_or_default();
                        if !g.is_match(&name) && !g.is_match(p.strip_prefix(&root).unwrap_or(&p)) { continue; }
                    }
                    let Ok(file) = std::fs::File::open(&p) else { continue };
                    let mut reader = BufReader::new(file);
                    if reader.fill_buf().unwrap_or_default().iter().take(8000).any(|&b| b == 0) { continue; }
                    let shown = super::slashes(p.strip_prefix(&cwd).unwrap_or(&p).display().to_string());
                    let mut count = 0;
                    if multiline {
                        let mut bytes = Vec::new();
                        reader.take(MULTILINE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
                        if bytes.len() as u64 > MULTILINE_BYTES { return Err(format!("{} exceeds the 8 MiB multiline limit; use line-by-line search", shown)); }
                        let text = String::from_utf8_lossy(&bytes);
                        let mut ranges = Vec::new();
                        let all_lines: Vec<_> = text.lines().collect();
                        let line_starts: Vec<_> = std::iter::once(0).chain(text.match_indices('\n').map(|(i, _)| i + 1)).collect();
                        for m in re.find_iter(&text) {
                            if cancel.is_cancelled() { return Err("interrupted".into()); }
                            count += 1;
                            if mode == "content" {
                                let start = line_starts.partition_point(|&i| i <= m.start()).saturating_sub(1);
                                let end = line_starts.partition_point(|&i| i <= m.end().saturating_sub(1)).saturating_sub(1);
                                ranges.push((start, end));
                            }
                        }
                        if mode == "content" {
                            let mut emitted = 0;
                            let mut match_cursor = 0;
                            for &(start, end) in &ranges {
                                let first = start.saturating_sub(before).max(emitted);
                                let last = (end + after + 1).min(all_lines.len());
                                for (i, line) in all_lines.iter().enumerate().take(last).skip(first) {
                                    while match_cursor < ranges.len() && ranges[match_cursor].1 < i { match_cursor += 1; }
                                    let matched = ranges.get(match_cursor).is_some_and(|&(a, b)| i >= a && i <= b);
                                    let n = i + 1;
                                    emit(if matched { format!("{shown}:{n}: {line}") } else { format!("{shown}-{n}- {line}") });
                                }
                                emitted = emitted.max(last);
                            }
                        }
                    } else {
                        let mut previous: VecDeque<(usize, String)> = VecDeque::new();
                        let (mut number, mut through, mut emitted) = (0, 0, 0);
                        let mut bytes = Vec::new();
                        loop {
                            if cancel.is_cancelled() { return Err("interrupted".into()); }
                            bytes.clear();
                            let n = std::io::Read::by_ref(&mut reader).take(1024 * 1024 + 1).read_until(b'\n', &mut bytes).map_err(|e| e.to_string())?;
                            if n > 1024 * 1024 { return Err(format!("{shown} has a line over 1 MiB; narrow the file or use bounded multiline mode")); }
                            if n == 0 { break; }
                            number += 1;
                            let line = String::from_utf8_lossy(&bytes);
                            let line = line.trim_end_matches(['\n','\r']);
                            if re.is_match(line) {
                                count += 1;
                                if mode == "content" {
                                    for (n, l) in &previous {
                                        if *n > emitted { emit(format!("{shown}-{n}- {l}")); }
                                    }
                                    emit(format!("{shown}:{number}: {line}"));
                                    emitted = number;
                                    through = number + after;
                                }
                                if mode == "files" { break; }
                            } else if mode == "content" && number <= through {
                                emit(format!("{shown}-{number}- {line}"));
                                emitted = number;
                            }
                            if before > 0 {
                                previous.push_back((number, line.to_owned()));
                                if previous.len() > before { previous.pop_front(); }
                            }
                        }
                    }
                    if count > 0 {
                        files += 1;
                        matches += count;
                        if mode == "files" { emit(shown); }
                        else if mode == "count" { emit(format!("{shown}:{count}")); }
                    }
                }
                let spill_hint = if output_bytes > super::output::TEXT_LIMIT { Some(spill.as_ref().map(|s| s.hint()).unwrap_or_else(|| "Full search output unavailable; use offset/head_limit for more".into())) } else { None };
                Ok((lines, files, matches, rows, spill_hint))
            }).await;
            let (lines, files, matches, rows, spill_hint) = match result {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => return ToolOutput::err(e),
                Err(_) => return ToolOutput::err("search failed"),
            };
            let summary = if str_arg(&input, "output_mode") == Some("content") { format!("{matches} matches in {files} files") } else { format!("{files} files") };
            let mut text = if lines.is_empty() { "no matches on this page".to_owned() } else { lines.join("\n") };
            if offset + limit < rows { text.push_str(&format!("\nMore: repeat grep with offset={} and head_limit={limit} ({rows} result lines total).", offset + limit)); }
            if let Some(hint) = spill_hint { text.push_str(&hint); }
            ToolOutput::ok(text, summary)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::{ctx, text};

    #[tokio::test]
    async fn context_paging_counts_and_large_stream() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a"), "before\nhit\nafter\nlast\n").unwrap();
        let (c, _rx) = ctx(dir.path());
        let out = Grep.run(&c, json!({"pattern":"hit","output_mode":"content","context":1})).await;
        assert_eq!(text(&out), "a-1- before\na:2: hit\na-3- after");
        let out = Grep.run(&c, json!({"pattern":"hit","output_mode":"content","context":1,"offset":1,"head_limit":1})).await;
        assert!(text(&out).starts_with("a:2: hit\nMore:"));
        let out = Grep.run(&c, json!({"pattern":"hit","output_mode":"count"})).await;
        assert_eq!(text(&out), "a:1");
        let out = Grep.run(&c, json!({"pattern":"hit\\nafter","multiline":true,"output_mode":"content","context":1})).await;
        assert_eq!(text(&out), "a-1- before\na:2: hit\na:3: after\na-4- last");
        let out = Grep.run(&c, json!({"pattern":"hit|after","output_mode":"content","context":1})).await;
        assert_eq!(text(&out).matches("a:2:").count(), 1);
        let mut f = std::fs::File::create(dir.path().join("large")).unwrap();
        use std::io::Write;
        for _ in 0..100_000 { writeln!(f, "{}", "x".repeat(100)).unwrap(); }
        writeln!(f, "needle").unwrap();
        let out = Grep.run(&c, json!({"path":"large","pattern":"needle","output_mode":"content"})).await;
        assert!(text(&out).contains("large:100001: needle"));
        let out = Grep.run(&c, json!({"path":"large","pattern":"needle","multiline":true})).await;
        assert!(!out.ok && text(&out).contains("8 MiB"));
    }

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
