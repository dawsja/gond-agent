//! Only built-in read tools are batchable: no recursion, shell execution or permission bypass.
use futures::future::{BoxFuture, join_all};
use serde_json::{Value, json};

use super::{Tool, ToolCtx, ToolOutput, schema, str_arg};
use crate::api::wire::ResultPart;
use crate::permissions::Access;

pub struct Batch;

fn tool(name: &str) -> Option<Box<dyn Tool>> {
    Some(match name {
        "read" => Box::new(super::fs::Read),
        "list_directory" => Box::new(super::search::ListDir),
        "glob" => Box::new(super::search::Glob),
        "grep" => Box::new(super::search::Grep),
        "symbols" => Box::new(super::symbols::Symbols),
        "bash_output" => Box::new(super::bash::BashOutput),
        _ => return None,
    })
}

impl Tool for Batch {
    fn name(&self) -> &'static str { "batch" }
    fn description(&self) -> &'static str {
        "Run 1-8 independent built-in read/search calls concurrently. Returns ordered, labeled results and per-call errors, including image results. Allowed: read, list_directory, glob, grep, symbols, bash_output. No nested batches or writes."
    }
    fn schema(&self) -> Value {
        schema(json!({"calls": {"type":"array", "minItems":1, "maxItems":8, "items": {
            "type":"object", "properties": {
                "tool":{"type":"string", "enum":["read","list_directory","glob","grep","symbols","bash_output"]},
                "input":{"type":"object"}
            }, "required":["tool","input"], "additionalProperties":false
        }}}), &["calls"])
    }
    fn access(&self) -> Access { Access::Read }
    fn title(&self, input: &Value) -> String {
        format!("{} reads", input["calls"].as_array().map_or(0, Vec::len))
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(calls) = input["calls"].as_array().filter(|c| !c.is_empty() && c.len() <= 8) else {
                return ToolOutput::err("calls must contain 1-8 independent read calls");
            };
            // Validate the entire batch before any calls run.
            if calls.iter().any(|c| tool(str_arg(c, "tool").unwrap_or("")).is_none() || !c["input"].is_object()) {
                return ToolOutput::err("Every call needs an allowed read tool and an input object");
            }
            let outputs = join_all(calls.iter().map(|c| async {
                tool(c["tool"].as_str().unwrap()).unwrap().run(ctx, c["input"].clone()).await
            })).await;
            let mut content = Vec::new();
            let mut failed = 0;
            for (i, (call, out)) in calls.iter().zip(outputs).enumerate() {
                failed += usize::from(!out.ok);
                content.push(ResultPart::Text { text: format!("# Result {}: {} ({})\nInput: {}", i + 1, call["tool"].as_str().unwrap(), if out.ok { "ok" } else { "error" }, super::compact_json(&call["input"], 500)) });
                content.extend(out.content);
            }
            ToolOutput { ok: failed == 0, content, summary: format!("{} results · {failed} errors", calls.len()), display: String::new(), diff: None }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::testutil::{ctx, text};

    #[tokio::test]
    async fn ordered_partial_failures_and_no_writes() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join("a"), "hello").unwrap();
        let (c, _rx) = ctx(d.path());
        let out = Batch.run(&c, json!({"calls":[{"tool":"read","input":{"path":"a"}},{"tool":"read","input":{"path":"missing"}}]})).await;
        assert!(!out.ok);
        assert!(text(&out).find("hello").unwrap() < text(&out).find("Result 2").unwrap());
        assert!(!Batch.run(&c, json!({"calls":[{"tool":"write","input":{"path":"b","content":"bad"}}]})).await.ok);
        assert!(!Batch.run(&c, json!({"calls":[{"tool":"batch","input":{}}]})).await.ok);
        assert!(!d.path().join("b").exists());
        assert!(c.reads.lock().unwrap().contains_key(&d.path().join("a")));
    }
}
