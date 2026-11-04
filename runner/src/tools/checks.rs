//! Optional command execution with small, format-oriented failure parsers.
use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{Value, json};
use super::{Tool, ToolCtx, ToolOutput, schema};
use crate::api::wire::ResultPart;
use crate::permissions::Access;

#[derive(Debug, Serialize, PartialEq)]
pub struct Failure { format: &'static str, message: String }
pub fn failures(text: &str) -> Vec<Failure> {
    text.lines().filter_map(|line| {
        let line = line.trim();
        let format = if line.starts_with("error[") || line.starts_with("error:") || (line.starts_with("test ") && line.ends_with("FAILED")) { "cargo" }
        else if line.starts_with("FAIL ") || line.starts_with("× ") || line.starts_with("npm ERR!") || line.starts_with("npm error") { "npm/vitest/jest" }
        else if line.starts_with("FAILED ") || line.starts_with("E   ") { "pytest" }
        else if line.starts_with("--- FAIL:") || line.starts_with("FAIL\t") { "go test" }
        else if line.contains("error TS") { "tsc" }
        else if line.contains("error") && (line.contains("✖") || line.split_whitespace().next().is_some_and(|v| v.contains(':') && v.chars().next().is_some_and(|c| c.is_ascii_digit()))) { "eslint" }
        else { return None; };
        Some(Failure { format, message: line.chars().take(500).collect() })
    }).take(30).collect()
}
pub struct RunChecks;
impl Tool for RunChecks {
    fn name(&self) -> &'static str { "run_checks" }
    fn description(&self) -> &'static str { "Run a supplied command with a timeout and return its exit status, duration and detected failures. Optional; background commands return a shell id for bash_output." }
    fn schema(&self) -> Value { schema(json!({"command":{"type":"string"},"cwd":{"type":"string","description":"Repository-relative working directory; default ."},"timeout_ms":{"type":"integer"},"run_in_background":{"type":"boolean"}}), &["command"]) }
    fn access(&self) -> Access { Access::Exec }
    fn title(&self, input: &Value) -> String { super::str_arg(input, "command").unwrap_or("?").into() }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let started = std::time::Instant::now();
            let background = input["run_in_background"].as_bool().unwrap_or(false);
            let cwd = input.get("cwd").and_then(Value::as_str).unwrap_or(".");
            if cwd != "." && (cwd.is_empty() || cwd.contains(['\\', ':']) || cwd.split('/').any(|p| p.is_empty() || p == "." || p == "..")) {
                return ToolOutput::err("cwd must be a repository-relative directory");
            }
            let mut check_ctx = ctx.clone();
            check_ctx.cwd = super::real(&ctx.cwd.join(cwd));
            if !check_ctx.cwd.starts_with(super::real(&ctx.cwd)) { return ToolOutput::err("cwd must stay inside the repository"); }
            let environment = if background { None } else { ctx.check_environment.as_ref() };
            let mode = environment.map(super::bash::ShellEnvironment::CleanCheck)
                .unwrap_or(super::bash::ShellEnvironment::InheritedCheck);
            let out = super::bash::execute(&check_ctx, input, mode).await;
            if background { return out; }
            let text = out.content.iter().filter_map(|p| match p { ResultPart::Text { text } => Some(text.as_str()), _ => None }).collect::<Vec<_>>().join("\n");
            let parsed = failures(&text);
            let exit = if out.ok { Some(0) } else { out.summary.strip_prefix("exit ").and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse::<i32>().ok()) };
            let tail = text.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            let result = json!({"exit_code":exit,"duration_seconds":started.elapsed().as_secs_f64(),"summary":out.summary,"failures":parsed,"output_tail":tail,"tests_ran":crate::agent::evidence::tests_ran(&text),"output_storage":text.lines().filter(|l| l.contains("output: /tmp/gond-agent-output/")).collect::<Vec<_>>()});
            ToolOutput { ok: out.ok, content: vec![ResultPart::Text { text: result.to_string() }], ..out }
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_fixture_formats() {
        for (text, format) in [("error[E0308]: mismatched types", "cargo"), ("FAIL src/a.test.ts", "npm/vitest/jest"), ("FAILED tests/test_a.py::test_a - AssertionError", "pytest"), ("--- FAIL: TestA (0.00s)", "go test"), ("a.ts(1,2): error TS2322: wrong type", "tsc"), ("1:2  error  Unexpected any  no-explicit-any", "eslint")] {
            assert_eq!(failures(text)[0].format, format);
        }
        assert!(failures("all passed").is_empty());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn real_check_command() {
        let d = tempfile::tempdir().unwrap();
        let (ctx, _rx) = super::super::testutil::ctx(d.path());
        let out = RunChecks.run(&ctx, json!({"command":"echo 'error TS2322: wrong type'; exit 2"})).await;
        let text = super::super::testutil::text(&out);
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["exit_code"], 2);
        assert_eq!(value["failures"][0]["format"], "tsc");
        assert!(!out.ok);
    }

    /// Seed a separate test process instead of racing set_var with other tests.
    #[cfg(unix)]
    #[tokio::test]
    async fn check_environments_preserve_toolchains_but_not_secrets() {
        const TEST: &str = "tools::checks::tests::check_environments_preserve_toolchains_but_not_secrets";
        const MARKER: &str = "GOND_AGENT_TEST_CHECK_ENV";
        const SECRET: &str = "check-secret-sentinel-never-print";
        const IMAGE: &[(&str, &str)] = &[
            ("NODE_PATH", "/fixture/browser/node_modules"),
            ("PLAYWRIGHT_BROWSERS_PATH", "/fixture/chromium"),
            ("BUN_INSTALL", "/fixture/bun"),
            ("UV_TOOL_DIR", "/fixture/uv"),
            ("PYTHONUSERBASE", "/fixture/python"),
        ];
        if std::env::var(MARKER).as_deref() != Ok(TEST) {
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child.args(["--exact", TEST, "--nocapture"]).env(MARKER, TEST).envs(IMAGE.iter().copied());
            for name in ["GH_TOKEN", "GITHUB_TOKEN", "GOND_AGENT_TOKEN", "GOND_AGENT_OTHER_SECRET", crate::config::RELAY_TOKEN_ENV] {
                child.env(name, SECRET);
            }
            // Harmless injection settings: eligible checks must nevertheless strip them.
            child.env("NODE_OPTIONS", "--trace-warnings").env("PYTHONPATH", "/fixture/injection")
                .env("BASH_ENV", "/fixture/nonexistent-bash-env");
            let output = child.output().unwrap();
            let logs = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            assert!(!logs.contains(SECRET), "fixture secret reached output");
            assert!(output.status.success(), "seeded checks failed: {logs}");
            assert!(logs.contains("1 passed"), "fixture test did not run");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (mut ctx, mut events) = super::super::testutil::ctx(dir.path());
        let no_secrets = r#"for name in $(compgen -e); do
case "$name" in GH_TOKEN|GITHUB_TOKEN|GOND_AGENT_*) exit 41;; esac
done"#;
        let inherited = format!(r#"{no_secrets}
test "$NODE_PATH" = /fixture/browser/node_modules &&
test "$PLAYWRIGHT_BROWSERS_PATH" = /fixture/chromium &&
test "$BUN_INSTALL" = /fixture/bun && test "$UV_TOOL_DIR" = /fixture/uv &&
test "$PYTHONUSERBASE" = /fixture/python && test "$NODE_OPTIONS" = --trace-warnings &&
test "$PYTHONPATH" = /fixture/injection && printf inherited-ok"#);
        // Model-provided flags cannot select the allow-list.
        let out = RunChecks.run(&ctx, json!({"command":inherited,"env_clean":true,"eligible":true})).await;
        assert!(out.ok, "noneligible check lost its image environment");
        assert!(super::super::testutil::text(&out).contains("inherited-ok"));

        ctx.check_environment = Some(crate::agent::evidence::check_environment());
        let clean = format!(r#"{no_secrets}
for name in NODE_PATH PLAYWRIGHT_BROWSERS_PATH BUN_INSTALL NODE_OPTIONS PYTHONPATH BASH_ENV; do
test -z "${{!name+x}}" || exit 42
done
test "$UV_TOOL_DIR" = /fixture/uv && test "$PYTHONUSERBASE" = /fixture/python && printf clean-ok"#);
        let out = RunChecks.run(&ctx, json!({"command":clean,"env_clean":false})).await;
        assert!(out.ok, "eligible check inherited injection variables");
        assert!(super::super::testutil::text(&out).contains("clean-ok"));

        // Even a context carrying eligibility must not clean a background check.
        let out = RunChecks.run(&ctx, json!({"command":format!("{inherited} > background.txt"),"run_in_background":true})).await;
        assert!(out.ok);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(dir.path().join("background.txt")).unwrap_or_default() == "inherited-ok" { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("background check lost toolchain variables or inherited a secret");

        // Ordinary bash retains GitHub/custom Gond variables and image variables;
        // only its pre-existing token exclusions apply.
        let bash = r#"test -n "$GH_TOKEN" && test -n "$GITHUB_TOKEN" && test -n "$GOND_AGENT_OTHER_SECRET" &&
test -z "${GOND_AGENT_RELAY_TOKEN+x}" && test -z "${GOND_AGENT_TOKEN+x}" &&
test "$BUN_INSTALL" = /fixture/bun && printf bash-unchanged"#;
        let out = super::super::bash::Bash.run(&ctx, json!({"command":bash})).await;
        assert!(out.ok, "ordinary bash environment contract changed");
        assert!(!format!("{out:?}").contains(SECRET));
        while let Ok(event) = events.try_recv() {
            assert!(!format!("{event:?}").contains(SECRET));
        }
    }
}
