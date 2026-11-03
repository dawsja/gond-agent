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
    fn schema(&self) -> Value { schema(json!({"command":{"type":"string"},"timeout_ms":{"type":"integer"},"run_in_background":{"type":"boolean"}}), &["command"]) }
    fn access(&self) -> Access { Access::Exec }
    fn title(&self, input: &Value) -> String { super::str_arg(input, "command").unwrap_or("?").into() }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let started = std::time::Instant::now();
            let background = input["run_in_background"].as_bool().unwrap_or(false);
            let out = super::bash::Bash.run(ctx, input).await;
            if background { return out; }
            let text = out.content.iter().filter_map(|p| match p { ResultPart::Text { text } => Some(text.as_str()), _ => None }).collect::<Vec<_>>().join("\n");
            let parsed = failures(&text);
            let exit = if out.ok { Some(0) } else { out.summary.strip_prefix("exit ").and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse::<i32>().ok()) };
            let tail = text.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            let result = json!({"exit_code":exit,"duration_seconds":started.elapsed().as_secs_f64(),"summary":out.summary,"failures":parsed,"output_tail":tail,"output_storage":text.lines().filter(|l| l.contains("output: /tmp/gond-agent-output/")).collect::<Vec<_>>()});
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
