//! apply_patch: multi-file edits in the patch format popularized by Codex.
//!
//! *** Begin Patch
//! *** Add File: path          (+ lines)
//! *** Update File: path       (optional "*** Move to: new/path"; hunks start with @@, lines prefixed ' ', '-', '+')
//! *** Delete File: path
//! *** End Patch

use futures::future::BoxFuture;
use serde_json::{Value, json};

use super::fs::{check_fresh, diff, remember};
use super::{Tool, ToolCtx, ToolOutput, schema, str_arg};
use crate::api::wire::ResultPart;
use crate::permissions::Access;

#[derive(Debug, PartialEq)]
enum Op {
    Add { path: String, lines: Vec<String> },
    Delete { path: String },
    Update { path: String, move_to: Option<String>, hunks: Vec<Vec<(char, String)>> },
}

fn parse(patch: &str) -> Result<Vec<Op>, String> {
    let lines: Vec<&str> = patch.lines().collect();
    let start = lines.iter().position(|l| l.trim() == "*** Begin Patch").ok_or("missing `*** Begin Patch`")?;
    let end = lines.iter().rposition(|l| l.trim() == "*** End Patch").ok_or("missing `*** End Patch`")?;
    let mut ops = vec![];
    let mut i = start + 1;
    while i < end {
        let l = lines[i];
        if let Some(p) = l.strip_prefix("*** Add File: ") {
            let mut body = vec![];
            i += 1;
            while i < end && !lines[i].starts_with("*** ") {
                body.push(lines[i].strip_prefix('+').ok_or_else(|| format!("line {}: added files need `+` on every line", i + 1))?.to_owned());
                i += 1;
            }
            ops.push(Op::Add { path: p.trim().to_owned(), lines: body });
        } else if let Some(p) = l.strip_prefix("*** Delete File: ") {
            ops.push(Op::Delete { path: p.trim().to_owned() });
            i += 1;
        } else if let Some(p) = l.strip_prefix("*** Update File: ") {
            i += 1;
            let mut move_to = None;
            if i < end {
                if let Some(m) = lines[i].strip_prefix("*** Move to: ") {
                    move_to = Some(m.trim().to_owned());
                    i += 1;
                }
            }
            let mut hunks: Vec<Vec<(char, String)>> = vec![];
            let mut cur: Vec<(char, String)> = vec![];
            while i < end && !(lines[i].starts_with("*** ") && lines[i] != "*** End of File") {
                let l = lines[i];
                if l.starts_with("@@") {
                    if !cur.is_empty() {
                        hunks.push(std::mem::take(&mut cur));
                    }
                } else if l == "*** End of File" {
                } else {
                    let (tag, rest) = match l.chars().next() {
                        Some(c @ (' ' | '-' | '+')) => (c, &l[1..]),
                        None => (' ', ""),
                        _ => return Err(format!("line {}: hunk lines must start with ' ', '-' or '+'", i + 1)),
                    };
                    cur.push((tag, rest.to_owned()));
                }
                i += 1;
            }
            if !cur.is_empty() {
                hunks.push(cur);
            }
            if hunks.is_empty() && move_to.is_none() {
                return Err(format!("no hunks for {p}"));
            }
            ops.push(Op::Update { path: p.trim().to_owned(), move_to, hunks });
        } else if l.trim().is_empty() {
            i += 1;
        } else {
            return Err(format!("line {}: expected a `*** Add/Update/Delete File:` header, got `{l}`", i + 1));
        }
    }
    if ops.is_empty() {
        return Err("the patch has no file operations".into());
    }
    Ok(ops)
}

/// Find `needle` in `hay` at or after `from`: exact, then ignoring trailing, then all surrounding whitespace.
fn find(hay: &[String], needle: &[String], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(hay.len());
    }
    let tries: [fn(&str, &str) -> bool; 3] = [|a, b| a == b, |a, b| a.trim_end() == b.trim_end(), |a, b| a.trim() == b.trim()];
    for eq in tries {
        for start in from..=hay.len().saturating_sub(needle.len()) {
            if hay.len() >= needle.len() && needle.iter().enumerate().all(|(k, n)| eq(&hay[start + k], n)) {
                return Some(start);
            }
        }
    }
    None
}

fn apply_hunks(text: &str, hunks: &[Vec<(char, String)>], path: &str) -> Result<String, String> {
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let trailing_nl = text.ends_with('\n') || text.is_empty();
    let mut cursor = 0;
    for (n, h) in hunks.iter().enumerate() {
        let old: Vec<String> = h.iter().filter(|(t, _)| *t != '+').map(|(_, s)| s.clone()).collect();
        let new: Vec<String> = h.iter().filter(|(t, _)| *t != '-').map(|(_, s)| s.clone()).collect();
        let at = find(&lines, &old, cursor).or_else(|| find(&lines, &old, 0)).ok_or_else(|| {
            format!("hunk {} did not match {path}; read the file again and copy the context lines exactly", n + 1)
        })?;
        lines.splice(at..at + old.len(), new.iter().cloned());
        cursor = at + new.len();
    }
    let mut out = lines.join("\n");
    if trailing_nl && !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

pub struct ApplyPatch;

impl Tool for ApplyPatch {
    fn name(&self) -> &'static str {
        "apply_patch"
    }
    fn description(&self) -> &'static str {
        "Edit several files at once with a patch:\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n context line\n-old line\n+new line\n*** Add File: src/b.ts\n+contents\n*** Delete File: src/c.ts\n*** End Patch\nInclude a few unchanged context lines around each change. Files being updated or deleted must have been read first. All files are checked before anything is written."
    }
    fn schema(&self) -> Value {
        schema(json!({"patch": {"type": "string"}}), &["patch"])
    }
    fn access(&self) -> Access {
        Access::Write
    }
    fn title(&self, input: &Value) -> String {
        match parse(str_arg(input, "patch").unwrap_or("")) {
            Ok(ops) => ops
                .iter()
                .map(|o| match o {
                    Op::Add { path, .. } | Op::Delete { path } => path.clone(),
                    Op::Update { path, move_to: Some(m), .. } => format!("{path} → {m}"),
                    Op::Update { path, move_to: None, .. } => path.clone(),
                })
                .collect::<Vec<_>>()
                .join(", "),
            Err(_) => "patch".into(),
        }
    }
    fn paths(&self, input: &Value) -> Vec<String> {
        let patch = input.get("patch").and_then(Value::as_str).unwrap_or("");
        let heads = ["*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "];
        patch.lines().filter_map(|l| heads.iter().find_map(|h| l.trim_end().strip_prefix(h)).map(|p| p.trim().to_owned())).collect()
    }

    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let ops = match parse(str_arg(&input, "patch").unwrap_or("")) {
                Ok(o) => o,
                Err(e) => return ToolOutput::err(format!("invalid patch: {e}")),
            };
            // Plan every change in memory first; write only if all of them apply.
            let mut writes: Vec<(std::path::PathBuf, Option<String>)> = vec![];
            let mut diffs = String::new();
            let (mut add, mut del) = (0, 0);
            for op in &ops {
                match op {
                    Op::Add { path, lines } => {
                        let p = ctx.resolve(path);
                        if let Err(e) = check_fresh(ctx, &p) {
                            return ToolOutput::err(format!("{e} (nothing was written)"));
                        }
                        if p.exists() {
                            return ToolOutput::err(format!("{path} already exists; use Update File (nothing was written)"));
                        }
                        let body = if lines.is_empty() { String::new() } else { lines.join("\n") + "\n" };
                        let (d, a, r) = diff("", &body, path);
                        (add, del) = (add + a, del + r);
                        diffs.push_str(&d);
                        writes.push((p, Some(body)));
                    }
                    Op::Delete { path } => {
                        let p = ctx.resolve(path);
                        if !p.exists() {
                            return ToolOutput::err(format!("{path} does not exist (nothing was written)"));
                        }
                        if let Err(e) = check_fresh(ctx, &p) {
                            return ToolOutput::err(format!("{e} (nothing was written)"));
                        }
                        let old = std::fs::read_to_string(&p).unwrap_or_default();
                        let (d, a, r) = diff(&old, "", path);
                        (add, del) = (add + a, del + r);
                        diffs.push_str(&d);
                        writes.push((p, None));
                    }
                    Op::Update { path, move_to, hunks } => {
                        let p = ctx.resolve(path);
                        if let Err(e) = check_fresh(ctx, &p) {
                            return ToolOutput::err(format!("{e} (nothing was written)"));
                        }
                        let old = match std::fs::read_to_string(&p) {
                            Ok(t) => t,
                            Err(e) => return ToolOutput::err(format!("cannot read {path}: {e} (nothing was written)")),
                        };
                        let new = match apply_hunks(&old, hunks, path) {
                            Ok(t) => t,
                            Err(e) => return ToolOutput::err(format!("{e} (nothing was written)")),
                        };
                        let shown = move_to.as_deref().unwrap_or(path);
                        let (d, a, r) = diff(&old, &new, shown);
                        (add, del) = (add + a, del + r);
                        diffs.push_str(&d);
                        match move_to {
                            Some(m) => {
                                let dest = ctx.resolve(m);
                                if dest != p {
                                    if let Err(e) = check_fresh(ctx, &dest) {
                                        return ToolOutput::err(format!("{e} (nothing was written)"));
                                    }
                                    writes.push((dest, Some(new)));
                                    writes.push((p, None));
                                } else {
                                    writes.push((p, Some(new)));
                                }
                            }
                            None => writes.push((p, Some(new))),
                        }
                    }
                }
            }
            for (p, _) in &writes {
                ctx.before_change(p);
            }
            for (p, body) in &writes {
                let r = match body {
                    Some(b) => p.parent().map(std::fs::create_dir_all).transpose().and_then(|_| std::fs::write(p, b)),
                    None => std::fs::remove_file(p),
                };
                if let Err(e) = r {
                    return ToolOutput::err(format!("failed writing {}: {e} (earlier files in this patch were written)", ctx.display(p)));
                }
                if body.is_some() {
                    remember(ctx, p);
                }
            }
            let files = ops.len();
            ToolOutput {
                ok: true,
                content: vec![ResultPart::Text { text: format!("applied patch to {files} file(s)") }],
                summary: format!("+{add} -{del} · {files} file{}", if files == 1 { "" } else { "s" }),
                display: String::new(),
                diff: Some(diffs),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::{ctx, text};

    #[tokio::test]
    async fn applies_multi_file_patches_atomically() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.ts"), "import x\n\nfunction f() {\n  return 1\n}\n").unwrap();
        std::fs::write(dir.path().join("gone.ts"), "bye\n").unwrap();
        let (c, _rx) = ctx(dir.path());
        let patch = "*** Begin Patch\n*** Update File: a.ts\n@@ function f\n function f() {\n-  return 1\n+  return 2\n }\n*** Add File: b.ts\n+export const b = 1\n*** Delete File: gone.ts\n*** End Patch";

        let unread = ApplyPatch.run(&c, json!({"patch": patch})).await;
        assert!(!unread.ok && text(&unread).contains("nothing was written"));
        assert!(!dir.path().join("b.ts").exists());

        crate::tools::fs::Read.run(&c, json!({"path":"a.ts"})).await;
        crate::tools::fs::Read.run(&c, json!({"path":"gone.ts"})).await;
        assert_eq!(ApplyPatch.title(&json!({"patch": patch})), "a.ts, b.ts, gone.ts");
        let ok = ApplyPatch.run(&c, json!({"patch": patch})).await;
        assert!(ok.ok, "{}", text(&ok));
        assert_eq!(ok.summary, "+2 -2 · 3 files");
        assert_eq!(std::fs::read_to_string(dir.path().join("a.ts")).unwrap(), "import x\n\nfunction f() {\n  return 2\n}\n");
        assert_eq!(std::fs::read_to_string(dir.path().join("b.ts")).unwrap(), "export const b = 1\n");
        assert!(!dir.path().join("gone.ts").exists());

        let bad = ApplyPatch.run(&c, json!({"patch": "*** Begin Patch\n*** Update File: a.ts\n@@\n-not there\n+x\n*** End Patch"})).await;
        assert!(!bad.ok && text(&bad).contains("hunk 1 did not match"));
    }

    #[test]
    fn parses_moves_and_rejects_garbage() {
        let ops = parse("*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n-x\n+y\n*** End Patch").unwrap();
        assert!(matches!(&ops[0], Op::Update { move_to: Some(m), .. } if m == "b"));
        assert!(parse("hello").is_err());
        assert!(parse("*** Begin Patch\nrandom\n*** End Patch").is_err());
    }
}
