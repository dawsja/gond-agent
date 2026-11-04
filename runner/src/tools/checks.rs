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
    fn description(&self) -> &'static str { "Run an exact discovered check command. For bug repros instead supply only repro (red/green), test_files (changed allow-listed repo-relative paths), cwd. Repro grammar has no command, flags or background option and a 120s limit. Unsupported runners require skip_repro." }
    fn schema(&self) -> Value { schema(json!({"command":{"type":"string"},"repro":{"type":"string","enum":["red","green"]},"test_files":{"type":"array","items":{"type":"string"}},"cwd":{"type":"string","description":"Repository-relative working directory; default ."},"timeout_ms":{"type":"integer"},"run_in_background":{"type":"boolean"}}), &[]) }
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
            let repro_runner = input.get("_repro_runner").and_then(Value::as_str).map(str::to_owned);
            let repro_report = input.get("_repro_report").and_then(Value::as_str).map(std::path::PathBuf::from);
            let out = super::bash::execute(&check_ctx, input, true).await;
            if background { return out; }
            let text = out.content.iter().filter_map(|p| match p { ResultPart::Text { text } => Some(text.as_str()), _ => None }).collect::<Vec<_>>().join("\n");
            let parsed = failures(&text);
            let exit = if out.ok { Some(0) } else { out.summary.strip_prefix("exit ").and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse::<i32>().ok()) };
            let tail = text.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            let mut result = json!({"exit_code":exit,"duration_seconds":started.elapsed().as_secs_f64(),"summary":out.summary,"failures":parsed,"output_tail":tail,"tests_ran":crate::agent::evidence::tests_ran(&text),"output_storage":text.lines().filter(|l| l.contains("output: /tmp/gond-agent-output/")).collect::<Vec<_>>()});
            if let Some(runner) = repro_runner {
                let report = repro_report.as_ref().and_then(|p| {
                    let meta = std::fs::symlink_metadata(p).ok()?;
                    if !meta.is_file() || meta.len() > 1_048_576 { return None; }
                    std::fs::read_to_string(p).ok()
                });
                if let Some(p) = repro_report { let _ = std::fs::remove_file(p); }
                let results = crate::agent::repro::classify(&runner, report.as_deref().unwrap_or(&out.display), exit);
                result["repro_results"] = serde_json::to_value(results).unwrap();
            }
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
}
