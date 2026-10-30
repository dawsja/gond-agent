//! The browser stays inside the workspace container. The model receives screenshots as image result parts.
use base64::Engine;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::process::Command;
use super::{Tool, ToolCtx, ToolOutput, schema, str_arg};
use crate::{api::wire::ResultPart, permissions::Access};

pub struct Browser;
impl Tool for Browser {
    fn name(&self) -> &'static str { "browser" }
    fn description(&self) -> &'static str {
        "Test a web app with container Playwright/Chromium at wide and phone viewports. Supply a URL and JavaScript test body using page and expect (Playwright assertions). Runs the test independently at both sizes, returns screenshots as images plus console/network failures. Example: await page.getByRole('button', {name:'Save'}).click(); await expect(page.getByText('Saved')).toBeVisible(); Inspect screenshots before finish_review."
    }
    fn schema(&self) -> Value {
        schema(json!({"url":{"type":"string"},"script":{"type":"string","description":"Async JavaScript test body with page and expect; use meaningful interactions/assertions"}}), &["url","script"])
    }
    fn access(&self) -> Access { Access::Exec }
    fn title(&self, input: &Value) -> String { str_arg(input,"url").unwrap_or("?").to_owned() }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(url) = str_arg(&input,"url").filter(|s| s.starts_with("http://") || s.starts_with("https://")) else { return ToolOutput::err("url must be HTTP or HTTPS"); };
            let Some(script) = str_arg(&input,"script").filter(|s| !s.trim().is_empty() && s.len() <= 32_000) else { return ToolOutput::err("Provide a Playwright test body (up to 32000 bytes)"); };
            let mut cmd = Command::new("node");
            cmd.arg("/opt/gond-agent-browser/browser.cjs");
            let bytes = match super::process::capture(ctx, cmd, json!({"url":url,"script":script}).to_string().into_bytes(), 12_000_000, 150).await {
                Ok(b) => b, Err(e) => return ToolOutput::err(e),
            };
            let report: Value = match serde_json::from_slice(&bytes) { Ok(v) => v, Err(_) => return ToolOutput::err("Browser returned an invalid report") };
            let mut content = Vec::new();
            let mut reports = Vec::new();
            let Some(results) = report["results"].as_array().filter(|r| r.len() == 2) else { return ToolOutput::err("Browser did not return both viewport results"); };
            for result in results {
                let mut details = result.clone();
                let image = details.as_object_mut().and_then(|o| o.remove("image")).and_then(|v| v.as_str().map(str::to_owned));
                let label = serde_json::to_string(&details).unwrap_or_default();
                reports.push(label.clone());
                content.push(ResultPart::Text { text: label });
                if let Some(data) = image.filter(|s| s.len() <= 6_000_000 && base64::engine::general_purpose::STANDARD.decode(s).is_ok()) {
                    content.push(ResultPart::Image { media_type: "image/jpeg".into(), data });
                }
            }
            let ok = report["ok"] == true && content.iter().filter(|p| matches!(p, ResultPart::Image {..})).count() == 2;
            ToolOutput { ok, content, summary: if ok { "wide + phone passed · inspect screenshots".into() } else { "browser checks failed".into() }, display: reports.join("\n"), diff: None }
        })
    }
}
