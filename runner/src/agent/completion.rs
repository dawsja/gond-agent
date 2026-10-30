//! Completion is a self-review gate, not a claim of human approval or a security boundary.
use std::collections::HashMap;
use std::path::Path;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::api::wire::ToolDef;
use crate::tools::{ToolCtx, schema, str_arg};

#[derive(Default)]
pub struct Completion {
    pub required: bool,
    pub web_app: bool,
    pub approved: Option<String>,
    pub blocker: Option<String>,
    pub evidence: HashMap<String, Evidence>,
}

pub struct Evidence {
    pub fingerprint: String,
    pub observed: bool,
    pub browser: bool,
    pub diff: bool,
}

pub fn definition() -> ToolDef {
    ToolDef {
        name: "finish_review".into(),
        description: "Required before completing coding work. Supply understanding, design, checks, diff_call_id, review and web_app. checks must cite successful foreground bash call IDs from this turn; diff_call_id must cite a successful git diff inspection. Delegated evidence uses agent_id:call_id. For web apps a successful browser call at wide and phone viewports is required: inspect its screenshots first. Evidence must match the current worktree; edits invalidate it. This is self-review, not human approval. If blocked, set blocked=true with limitations instead of claiming done; the run fails without publishing.".into(),
        input_schema: schema(json!({
            "understanding":{"type":"string"}, "design":{"type":"string"},
            "checks":{"type":"array","items":{"type":"string"}},
            "diff_call_id":{"type":"string"}, "review":{"type":"string"},
            "web_app":{"type":"boolean"}, "limitations":{"type":"string"},
            "blocked":{"type":"boolean","description":"Report an unresolvable verification blocker instead of completing; limitations is required. The run fails without publishing changes."}
        }), &[]),
    }
}

impl Completion {
    pub fn review(&mut self, input: &Value, fingerprint: &str) -> Result<(), &'static str> {
        for key in ["understanding", "design", "review"] {
            if str_arg(input, key).is_none_or(|s| s.trim().is_empty()) { return Err("Describe your understanding, design and final self-review"); }
        }
        let current = |id: &str| self.evidence.get(id).filter(|e| e.observed && e.fingerprint == fingerprint);
        let Some(checks) = input["checks"].as_array().filter(|c| !c.is_empty()) else { return Err("Cite successful verification call IDs in checks"); };
        if checks.iter().any(|id| id.as_str().and_then(current).is_none_or(|e| e.browser || e.diff)) {
            return Err("checks must cite successful foreground bash results on the current worktree, not browser or diff calls");
        }
        if str_arg(input, "diff_call_id").and_then(current).is_none_or(|e| !e.diff) {
            return Err("Inspect the final git diff (and new files), then cite that successful call in diff_call_id");
        }
        let Some(web_app) = input["web_app"].as_bool() else { return Err("web_app must be a boolean"); };
        if (self.web_app || web_app) && !self.evidence.values().any(|e| e.browser && e.observed && e.fingerprint == fingerprint) {
            return Err("Web apps require a successful browser test at wide and phone viewports on the current worktree; inspect both screenshots");
        }
        self.approved = Some(fingerprint.to_owned());
        Ok(())
    }
}

/// Hash tracked changes and untracked file bytes, not mtimes. Build output ignored by Git is excluded.
/// Any failure makes evidence unavailable instead of silently accepting stale proof.
pub async fn fingerprint(ctx: &ToolCtx) -> Option<String> {
    let mut head = Command::new("git");
    head.args(["rev-parse", "HEAD"]);
    let head = crate::tools::process::capture(ctx, head, vec![], 100, 20).await.ok()?;
    let mut diff = Command::new("git");
    diff.args(["-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", "--"]);
    let bytes = crate::tools::process::capture(ctx, diff, vec![], 8_000_000, 20).await.ok()?;
    let mut hash = Sha256::new();
    hash.update(head);
    hash.update(bytes);
    let mut untracked = Command::new("git");
    untracked.args(["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "-z"]);
    let bytes = crate::tools::process::capture(ctx, untracked, vec![], 1_000_000, 20).await.ok()?;
    let mut paths: Vec<_> = bytes.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
    paths.sort_unstable();
    for path in paths {
        let path_str = std::str::from_utf8(path).ok()?;
        hash.update((path.len() as u64).to_le_bytes());
        hash.update(path);
        let full = ctx.cwd.join(path_str);
        let meta = tokio::fs::symlink_metadata(&full).await.ok()?;
        if meta.file_type().is_symlink() {
            hash.update(tokio::fs::read_link(full).await.ok()?.as_os_str().as_encoded_bytes());
        } else {
            let mut file = tokio::fs::File::open(full).await.ok()?;
            hash.update(meta.len().to_le_bytes());
            let mut chunk = [0u8; 16384];
            loop {
                let n = tokio::select! { n = file.read(&mut chunk) => n.ok()?, _ = ctx.cancel.cancelled() => return None };
                if n == 0 { break; }
                hash.update(&chunk[..n]);
            }
        }
    }
    Some(format!("{:x}", hash.finalize()))
}

pub fn is_web_app(cwd: &Path) -> bool {
    ignore::WalkBuilder::new(cwd).hidden(true).max_depth(Some(3))
        .filter_entry(|e| !matches!(e.file_name().to_str(), Some("node_modules" | "target" | "dist" | "vendor" | ".git")))
        .build().filter_map(Result::ok).any(|e| {
            if e.file_name() == "index.html" { return true; }
            if e.file_name() != "package.json" { return false; }
            let Some(package) = std::fs::read(e.path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()) else { return false; };
            ["dependencies", "devDependencies"].iter().any(|key| package[*key].as_object().is_some_and(|deps| {
                ["next","vite","react-scripts","@sveltejs/kit","astro","nuxt","@angular/core"].iter().any(|name| deps.contains_key(*name))
            }))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_requires_fresh_checks_diff_and_browser() {
        let mut c = Completion { web_app: true, ..Default::default() };
        let input = json!({"understanding":"traced callers", "design":"follow existing form", "checks":["test"], "diff_call_id":"diff", "review":"reviewed all changes", "web_app":false});
        assert!(c.review(&input,"a").is_err());
        c.evidence.insert("test".into(), Evidence {fingerprint:"a".into(), observed:true, browser:false, diff:false});
        c.evidence.insert("diff".into(), Evidence {fingerprint:"a".into(), observed:true, browser:false, diff:true});
        assert!(c.review(&input,"a").is_err());
        c.evidence.insert("browser".into(), Evidence {fingerprint:"a".into(), observed:false, browser:true, diff:false});
        assert!(c.review(&input,"a").is_err(), "screenshots must reach the next model request before review");
        c.evidence.get_mut("browser").unwrap().observed = true;
        assert!(c.review(&input,"a").is_ok());
        assert!(c.review(&input,"changed").is_err());
        assert!(c.review(&json!({}),"a").is_err());
    }

    #[tokio::test]
    async fn fingerprint_tracks_staged_unstaged_and_new_files() {
        let d = tempfile::tempdir().unwrap();
        let (ctx, _rx) = crate::tools::testutil::ctx(d.path());
        for args in [vec!["init"], vec!["-c","user.name=Test","-c","user.email=test@localhost","commit","--allow-empty","-m","init"]] {
            assert!(Command::new("git").args(args).current_dir(d.path()).output().await.unwrap().status.success());
        }
        let a = fingerprint(&ctx).await.unwrap();
        std::fs::write(d.path().join("a"), "one").unwrap();
        let b = fingerprint(&ctx).await.unwrap();
        assert_ne!(a,b);
        std::fs::write(d.path().join("a"), "two").unwrap();
        assert_ne!(b,fingerprint(&ctx).await.unwrap());
        Command::new("git").args(["add","a"]).current_dir(d.path()).output().await.unwrap();
        let staged = fingerprint(&ctx).await.unwrap();
        assert_ne!(a,staged);
        std::fs::write(d.path().join("a"), "three").unwrap();
        assert_ne!(staged,fingerprint(&ctx).await.unwrap());
    }
}
