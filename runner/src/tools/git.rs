//! Read-only Git inspection. Arguments are data, never shell source.
use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::process::Command;
use super::{Tool, ToolCtx, ToolOutput, schema, str_arg};
use crate::permissions::Access;

pub struct Git;
impl Tool for Git {
    fn name(&self) -> &'static str { "git" }
    fn description(&self) -> &'static str { "Inspect repository status, diff, log, show or blame without changing Git state. Use path, range, stat and limit to narrow output." }
    fn schema(&self) -> Value {
        schema(json!({"action":{"type":"string","enum":["status","diff","log","show","blame"]},"path":{"type":"string"},"range":{"type":"string"},"stat":{"type":"boolean"},"limit":{"type":"integer","minimum":1,"maximum":100},"line_start":{"type":"integer","minimum":1},"line_end":{"type":"integer","minimum":1}}), &["action"])
    }
    fn access(&self) -> Access { Access::Read }
    fn title(&self, input: &Value) -> String { str_arg(input, "action").unwrap_or("?").into() }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let action = str_arg(&input, "action").unwrap_or("");
            if !["status", "diff", "log", "show", "blame"].contains(&action) { return ToolOutput::err("Choose status, diff, log, show or blame; this tool is read-only"); }
            let range = str_arg(&input, "range").unwrap_or("");
            if range.starts_with('-') || range.contains(['\0','\n','\r']) { return ToolOutput::err("Invalid revision or range"); }
            let mut probe = Command::new("git");
            probe.args(["rev-parse", "--show-toplevel"]);
            if super::process::capture(ctx, probe, vec![], 4096, 10).await.is_err() { return ToolOutput::err("The workspace is not a Git repository, or Git is unavailable"); }
            let mut cmd = Command::new("git");
            cmd.env("GIT_OPTIONAL_LOCKS", "0").args(["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", action]);
            match action {
                "status" => { cmd.args(["--short", "--branch"]); }
                "diff" | "show" => { cmd.args(["--no-ext-diff", "--no-textconv"]); if input["stat"].as_bool() == Some(true) { cmd.arg("--stat"); } }
                "log" => { cmd.arg("--oneline").arg(format!("-n{}", input["limit"].as_u64().unwrap_or(20).clamp(1,100))); if input["stat"].as_bool() == Some(true) { cmd.arg("--stat"); } }
                "blame" => {
                    cmd.arg("--no-textconv");
                    if let Some(start) = input["line_start"].as_u64().filter(|n| *n > 0) {
                        let end = input["line_end"].as_u64().unwrap_or(start);
                        if end < start { return ToolOutput::err("line_end must be at least line_start"); }
                        cmd.args(["-L", &format!("{start},{end}")]);
                    }
                }
                _ => {}
            }
            if !range.is_empty() && action != "status" { cmd.arg(range); }
            cmd.arg("--");
            if let Some(path) = str_arg(&input, "path") { cmd.arg(path); }
            match super::process::capture(ctx, cmd, vec![], 32 * 1024 * 1024, 30).await {
                Ok(bytes) => ToolOutput::ok(String::from_utf8_lossy(&bytes), action),
                Err(e) => ToolOutput::err(e),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::{ctx, text};
    #[tokio::test]
    async fn real_repository_status_and_no_write_actions() {
        let d = tempfile::tempdir().unwrap();
        let (c, _rx) = ctx(d.path());
        assert!(text(&Git.run(&c, json!({"action":"status"})).await).contains("not a Git repository"));
        assert!(std::process::Command::new("git").arg("init").arg(d.path()).output().unwrap().status.success());
        std::fs::write(d.path().join("new.txt"), "hello").unwrap();
        assert!(text(&Git.run(&c, json!({"action":"status"})).await).contains("new.txt"));
        assert!(!Git.run(&c, json!({"action":"commit"})).await.ok);
        assert!(!Git.run(&c, json!({"action":"show","range":"--output=bad"})).await.ok);
    }
}
