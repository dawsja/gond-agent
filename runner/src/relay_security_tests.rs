//! Regression guards for the worker's private relay credential and subprocess boundary.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::StreamExt;
use serde_json::{Value, json};

use crate::api::{ApiClient, wire::{Block, Message, Metadata, ResponsesRequest, StreamEvent}};
use crate::tools::{Tool, testutil::{ctx, http::{Req, Res, serve}}};
#[cfg(unix)]
use crate::tools::testutil::text;

const TOKEN: &str = "relay-secret-sentinel";

#[tokio::test]
async fn bearer_auth_covers_models_image_stream_retries_and_search() {
    let seen = Arc::new(Mutex::new(Vec::<Req>::new()));
    let recorded = seen.clone();
    let url = serve(move |req| {
        let mut seen = recorded.lock().unwrap();
        let response_attempt = seen.iter().filter(|r| r.head.starts_with("post /v1/responses ")).count();
        let res = if req.head.starts_with("get /v1/models ") {
            Res::new(200, "application/json", r#"{"models":[{"id":"m"}]}"#)
        } else if req.head.starts_with("post /v1/search ") {
            Res::new(200, "application/json", r#"{"results":[]}"#)
        } else if response_attempt == 0 {
            Res::new(503, "application/json", r#"{"error":{"code":"busy","message":"Try again","retryable":true}}"#)
        } else {
            Res::new(200, "text/event-stream", "event: response.end\ndata: {}\n\n")
        };
        seen.push(req);
        res
    }).await;
    let api = ApiClient::new(url, Some(TOKEN.into())).with_retry_delay(Duration::ZERO);
    let models: Value = api.get("/v1/models").await.unwrap();
    assert_eq!(models["models"][0]["id"], "m");
    // Images travel inline in responses, not through a separate image HTTP client.
    let mut message = Message::user_text("Describe this image");
    message.content.push(Block::Image { media_type: "image/png".into(), data: "aW1hZ2U=".into(), id: None });
    let request = ResponsesRequest {
        model: "m".into(), system: None, messages: vec![message], tools: vec![],
        max_output_tokens: None, reasoning: None, metadata: Metadata::default(),
    };
    let mut stream = api.responses(&request).await.unwrap();
    let mut ended = false;
    while let Some(event) = stream.next().await {
        ended |= matches!(event.unwrap(), StreamEvent::End { .. });
    }
    assert!(ended);
    let dir = tempfile::tempdir().unwrap();
    let (ctx, _rx) = ctx(dir.path());
    let result = crate::tools::web_search::WebSearch { api }.run(&ctx, json!({"query":"test"})).await;
    assert!(result.ok);
    assert!(!format!("{result:?}").contains(TOKEN));

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 4);
    for req in seen.iter() {
        assert_eq!(req.header("authorization").as_deref(), Some("bearer relay-secret-sentinel"));
        assert!(!req.head.lines().next().unwrap().contains(TOKEN), "credential must not enter URLs");
        assert!(!String::from_utf8_lossy(&req.body).contains(TOKEN), "credential must not enter model/tool payloads");
    }
    assert!(seen[1].head.starts_with("post /v1/responses "));
    assert_eq!(seen[1].body, seen[2].body);
    assert_eq!(seen[1].json()["messages"][0]["content"][1]["data"], "aW1hZ2U=");
    assert!(seen[3].head.starts_with("post /v1/search "));
}

#[tokio::test]
async fn relay_redirects_are_never_followed_even_on_the_same_origin() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    let url = serve(move |req| {
        recorded.lock().unwrap().push(req.head);
        Res { headers: "location: /stolen\r\n".into(), ..Res::new(307, "application/json", "{}") }
    }).await;
    let api = ApiClient::new(url, Some(TOKEN.into()));
    let error = api.get::<Value>("/v1/models").await.unwrap_err();
    assert!(!format!("{error:?} {}", api.describe(&error)).contains(TOKEN));
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "even a same-origin redirect would forward the bearer header");
    assert!(seen[0].starts_with("get /v1/models "));
}

/// Re-exec only the named test with a seeded environment. No set_var/remove_var races with
/// Tokio or the other tests; the token is passed in the child's environment, never its argv.
#[cfg(unix)]
pub(crate) fn seeded(test: &str) -> bool {
    const MARKER: &str = "GOND_AGENT_TEST_SEEDED_RELAY";
    if std::env::var(MARKER).as_deref() == Ok(test) {
        assert_eq!(std::env::var(crate::config::RELAY_TOKEN_ENV).unwrap(), TOKEN);
        return true;
    }
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    // An actually spawned node stand-in exercises Browser's process path without requiring
    // Chromium here. Image/browser smoke tests separately cover real Playwright execution.
    let node = dir.path().join("node");
    std::fs::write(&node, r##"#!/bin/sh
[ "${GOND_AGENT_RELAY_TOKEN+x}" != x ] || exit 41
[ "$1" = /opt/gond-agent-browser/browser.cjs ] || exit 42
input=$(cat)
case "$input" in *relay-probe*) ;; *) exit 43 ;; esac
printf '%s' '{"ok":true,"results":[{"viewport":"wide","probe":"browser-child-scrubbed","image":"eA=="},{"viewport":"phone","image":"eA=="}]}'
"##).unwrap();
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut paths = vec![dir.path().to_path_buf()];
    paths.extend(std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()));
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(MARKER, test)
        .env(crate::config::RELAY_TOKEN_ENV, TOKEN)
        .env("PATH", std::env::join_paths(paths).unwrap())
        .output().unwrap();
    let logs = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(!logs.contains(TOKEN), "child test output exposed the relay credential");
    assert!(output.status.success(), "seeded child failed: {logs}");
    assert!(logs.contains("1 passed"), "child did not execute the requested test: {logs}");
    false
}

#[cfg(unix)]
#[tokio::test]
async fn spawned_tool_children_cannot_inherit_relay_authentication() {
    if !seeded("relay_security_tests::spawned_tool_children_cannot_inherit_relay_authentication") { return; }
    let dir = tempfile::tempdir().unwrap();
    let (ctx, mut events) = ctx(dir.path());
    let command = "test \"${GOND_AGENT_RELAY_TOKEN+x}\" != x && printf child-scrubbed";
    for tool in [&crate::tools::bash::Bash as &dyn Tool, &crate::tools::checks::RunChecks] {
        let out = tool.run(&ctx, json!({"command":command,"timeout_ms":5000})).await;
        assert!(out.ok, "{} failed", tool.name());
        assert!(text(&out).contains("child-scrubbed"));
        assert!(!format!("{out:?}").contains(TOKEN));
        // Background execution is a separate spawn site in Bash (also used by RunChecks).
        let marker = format!("{}-background.txt", tool.name());
        let out = tool.run(&ctx, json!({"command":format!("{command} > {marker}"),"run_in_background":true})).await;
        assert!(out.ok);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(dir.path().join(&marker)).unwrap_or_default() == "child-scrubbed" { break; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("background child did not confirm a scrubbed environment");
    }
    // The browser uses capture rather than the bash execution path.
    let out = crate::tools::browser::Browser.run(&ctx, json!({"url":"http://example.test","script":"// relay-probe"})).await;
    assert!(out.ok);
    assert!(text(&out).contains("browser-child-scrubbed"));
    // Explicitly supplied env values must be removed too, not only inherited ones.
    let mut command = tokio::process::Command::new("sh");
    command.args(["-c", "test \"${GOND_AGENT_RELAY_TOKEN+x}\" != x && printf capture-scrubbed"])
        .env(crate::config::RELAY_TOKEN_ENV, "override");
    let bytes = crate::tools::process::capture(&ctx, command, vec![], 100, 5).await.unwrap();
    assert_eq!(bytes, b"capture-scrubbed");
    while let Ok(event) = events.try_recv() {
        assert!(!format!("{event:?}").contains(TOKEN));
    }
}

#[cfg(unix)]
#[tokio::test]
async fn mcp_cannot_inherit_or_expand_relay_authentication() {
    if !seeded("relay_security_tests::mcp_cannot_inherit_or_expand_relay_authentication") { return; }
    use crate::mcp::{Client, ServerConfig};
    use std::collections::HashMap;
    assert_eq!(crate::mcp::expand_env("before${GOND_AGENT_RELAY_TOKEN}after"), "beforeafter");
    let script = r#"
[ "${GOND_AGENT_RELAY_TOKEN+x}" != x ] || exit 41
[ "$ALIAS" = beforeafter ] || exit 42
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"child-scrubbed"}]}}\n' "$id" ;;
  esac
done"#;
    for env in [
        HashMap::from([("ALIAS".into(), "before${GOND_AGENT_RELAY_TOKEN}after".into())]),
        HashMap::from([("ALIAS".into(), "before${GOND_AGENT_RELAY_TOKEN}after".into()), (crate::config::RELAY_TOKEN_ENV.into(), "override".into())]),
    ] {
        let cfg = ServerConfig { command: Some("sh".into()), args: vec!["-c".into(), script.into()], env, url: None, headers: HashMap::new(), kind: None };
        let client = Client::connect(&cfg).await.unwrap();
        assert_eq!(client.list_tools().await.unwrap()[0]["name"], "child-scrubbed");
    }
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = seen.clone();
    let url = serve(move |req| {
        let id = req.json()["id"].clone();
        recorded.lock().unwrap().push(req);
        Res::new(200, "application/json", json!({"jsonrpc":"2.0","id":id,"result":{"tools":[]}}).to_string())
    }).await;
    let cfg = ServerConfig {
        command: None, args: vec![], env: HashMap::new(),
        url: Some(format!("{url}/mcp${{GOND_AGENT_RELAY_TOKEN}}")),
        headers: HashMap::from([("X-Relay-Probe".into(), "before${GOND_AGENT_RELAY_TOKEN}after".into())]), kind: Some("http".into()),
    };
    let client = Client::connect(&cfg).await.unwrap();
    assert!(client.list_tools().await.unwrap().is_empty());
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 3);
    for req in seen.iter() {
        assert!(req.head.starts_with("post /mcp "));
        assert_eq!(req.header("x-relay-probe").as_deref(), Some("beforeafter"));
        assert!(req.header("authorization").is_none());
        assert!(!req.head.contains(TOKEN));
        assert!(!String::from_utf8_lossy(&req.body).contains(TOKEN));
    }
}
