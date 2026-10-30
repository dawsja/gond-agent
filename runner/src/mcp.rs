//! Minimal MCP client: initialize, tools/list, tools/call over two transports.
//! - stdio: JSON-RPC 2.0, one message per line on the child's stdin/stdout.
//! - Streamable HTTP: POST each message to one endpoint; the reply is JSON or an SSE stream.
//!
//! Config uses the common `mcpServers` shape, so existing configs can be reused
//! (.gond-agent/mcp.json and ~/.gond-agent/mcp.json):
//!   {"mcpServers": {
//!     "local":  {"command": "npx", "args": ["-y", "some-server"], "env": {}},
//!     "remote": {"type": "http", "url": "https://mcp.example.com/mcp", "headers": {"Authorization": "Bearer ${TOKEN}"}}
//!   }}
//! `${VAR}` in url, headers and env is replaced from the environment, so secrets stay out of the file.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use futures::StreamExt;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

use crate::api::client::SseDecoder;
use crate::api::wire::ResultPart;
use crate::permissions::Access;
use crate::tools::{Tool, ToolCtx, ToolOutput};

const PROTOCOL: &str = "2025-06-18";

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// "stdio" | "http" (inferred from `command` / `url` when absent).
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
}

impl ServerConfig {
    pub fn describe(&self) -> String {
        let base = match (&self.url, &self.command) {
            (Some(u), _) => u.clone(),
            (None, Some(c)) => format!("{c} {}", self.args.join(" ")).trim_end().to_owned(),
            _ => String::new(),
        };
        let mut extra: Vec<String> = vec![];
        if !self.env.is_empty() {
            let mut keys: Vec<&str> = self.env.keys().map(String::as_str).collect();
            keys.sort_unstable();
            extra.push(format!("env: {}", keys.join(", ")));
        }
        if !self.headers.is_empty() {
            let mut keys: Vec<&str> = self.headers.keys().map(String::as_str).collect();
            keys.sort_unstable();
            extra.push(format!("headers: {}", keys.join(", ")));
        }
        if extra.is_empty() { base } else { format!("{base} ({})", extra.join("; ")) }
    }
}

#[derive(Deserialize, Default)]
struct ConfigFile {
    #[serde(default, rename = "mcpServers")]
    servers: HashMap<String, ServerConfig>,
}

fn read_servers(path: &Path) -> HashMap<String, ServerConfig> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<ConfigFile>(&text)
            .map(|f| f.servers)
            .unwrap_or_else(|e| {
                eprintln!("gond-agent: ignoring {}: {e}", path.display());
                HashMap::new()
            }),
        Err(_) => HashMap::new(),
    }
}

/// The folder's own servers (.gond-agent/mcp.json), sorted by name.
pub fn project_servers(cwd: &Path) -> Vec<(String, ServerConfig)> {
    let mut v: Vec<_> = read_servers(&cwd.join(".gond-agent").join("mcp.json")).into_iter().collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

/// Servers from the global then project config; project entries win on name clashes. A folder's own
/// servers run in the isolated checkout.
fn load_config(cwd: &Path, trusted: bool) -> Vec<(String, ServerConfig)> {
    let mut all = read_servers(&crate::config::home().join("mcp.json"));
    if trusted {
        all.extend(project_servers(cwd));
    }
    let mut v: Vec<_> = all.into_iter().collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}

/// Replace `${VAR}` with the environment value (empty if unset; `GOND_AGENT_TOKEN` is never expanded).
pub fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        match rest[i + 2..].find('}') {
            Some(j) => {
                let name = &rest[i + 2..i + 2 + j];
                if name != "GOND_AGENT_TOKEN" {
                    out.push_str(&std::env::var(name).unwrap_or_default());
                }
                rest = &rest[i + 3 + j..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

// One per connected server, so the size difference between the variants (larger on Windows) doesn't matter.
#[allow(clippy::large_enum_variant)]
enum Transport {
    Stdio { stdin: tokio::sync::Mutex<ChildStdin>, pending: Pending, _child: Mutex<Child> },
    Http { http: reqwest::Client, url: String, headers: Vec<(String, String)>, session: Mutex<Option<String>>, initialized: std::sync::atomic::AtomicBool },
}

pub struct Client {
    transport: Transport,
    next: AtomicU64,
}

fn rpc_result(msg: &Value) -> Result<Value, String> {
    match msg.get("error") {
        Some(e) => Err(e.get("message").and_then(Value::as_str).unwrap_or("error").to_owned()),
        None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
    }
}

impl Client {
    pub async fn connect(cfg: &ServerConfig) -> Result<Arc<Client>> {
        let http = cfg.kind.as_deref().map_or(cfg.url.is_some(), |k| matches!(k, "http" | "streamable-http" | "streamableHttp"));
        if cfg.kind.as_deref() == Some("sse") {
            bail!("the legacy SSE transport is not supported; use the server's Streamable HTTP endpoint (type \"http\")");
        }
        let transport = if http { Self::http(cfg)? } else { Self::stdio(cfg)? };
        let client = Arc::new(Client { transport, next: AtomicU64::new(1) });
        client
            .request(
                "initialize",
                json!({"protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": {"name": "gond-agent", "version": env!("CARGO_PKG_VERSION")}}),
                Duration::from_secs(15),
            )
            .await?;
        if let Transport::Http { initialized, .. } = &client.transport {
            initialized.store(true, Ordering::Relaxed);
        }
        client.notify("notifications/initialized").await?;
        Ok(client)
    }

    fn stdio(cfg: &ServerConfig) -> Result<Transport> {
        let command = cfg.command.as_deref().ok_or_else(|| anyhow!("needs a `command` (stdio) or a `url` (http)"))?;
        let mut child = Command::new(command)
            .args(&cfg.args)
            .envs(cfg.env.iter().map(|(k, v)| (k, expand_env(v))))
            .env_remove("GOND_AGENT_TOKEN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| anyhow!("cannot start `{command}`: {e}"))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let pending: Pending = Arc::default();
        let p = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                // Responses only; server-initiated requests and notifications are ignored.
                let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
                if msg.get("method").is_some() {
                    continue;
                }
                if let Some(tx) = p.lock().unwrap().remove(&id) {
                    let _ = tx.send(rpc_result(&msg));
                }
            }
            // Server exited: fail everything still waiting.
            for (_, tx) in p.lock().unwrap().drain() {
                let _ = tx.send(Err("server exited".into()));
            }
        });
        Ok(Transport::Stdio { stdin: tokio::sync::Mutex::new(stdin), pending, _child: Mutex::new(child) })
    }

    fn http(cfg: &ServerConfig) -> Result<Transport> {
        let url = expand_env(cfg.url.as_deref().ok_or_else(|| anyhow!("http servers need a `url`"))?);
        let headers = cfg.headers.iter().map(|(k, v)| (k.clone(), expand_env(v))).collect();
        let http = crate::http::builder().build()?;
        Ok(Transport::Http { http, url, headers, session: Mutex::new(None), initialized: Default::default() })
    }

    /// POST one JSON-RPC message (Streamable HTTP). Returns the matching response for requests.
    async fn http_post(&self, msg: &Value, want_id: Option<u64>, timeout: Duration) -> Result<Option<Value>> {
        let Transport::Http { http, url, headers, session, initialized } = &self.transport else { unreachable!() };
        let mut req = http
            .post(url)
            .timeout(timeout)
            .header(reqwest::header::ACCEPT, "application/json, text/event-stream")
            .json(msg);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        if let Some(sid) = session.lock().unwrap().clone() {
            req = req.header("Mcp-Session-Id", sid);
        }
        if initialized.load(Ordering::Relaxed) {
            req = req.header("MCP-Protocol-Version", PROTOCOL);
        }
        let res = req.send().await.map_err(|e| anyhow!("cannot reach {url}: {e}"))?;
        if let Some(sid) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *session.lock().unwrap() = Some(sid.to_owned());
        }
        let status = res.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            bail!("HTTP {status}: the server needs credentials; add them under `headers` (OAuth sign-in is not supported yet)");
        }
        if status == reqwest::StatusCode::NOT_FOUND && session.lock().unwrap().is_some() {
            bail!("the server ended the MCP session; restart Gond Agent to reconnect");
        }
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            bail!("HTTP {status}: {}", body.chars().take(200).collect::<String>());
        }
        let Some(id) = want_id else { return Ok(None) };
        let is_sse = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|ct| ct.starts_with("text/event-stream"));
        let matches = |m: &Value| m.get("id").and_then(Value::as_u64) == Some(id) && m.get("method").is_none();
        if !is_sse {
            let body: Value = res.json().await?;
            // A single response, or a batch.
            let found = if body.is_array() { body.as_array().unwrap().iter().find(|m| matches(m)).cloned() } else { Some(body).filter(|m| matches(m)) };
            return found.map(|m| rpc_result(&m).map_err(|e| anyhow!(e))).transpose();
        }
        // SSE: the server may send notifications/requests first; read until our response arrives.
        let mut stream = res.bytes_stream();
        let mut dec = SseDecoder::default();
        while let Some(chunk) = stream.next().await {
            for (_, data) in dec.feed(&chunk?) {
                let Ok(m) = serde_json::from_str::<Value>(&data) else { continue };
                if matches(&m) {
                    return rpc_result(&m).map(Some).map_err(|e| anyhow!(e));
                }
            }
        }
        bail!("the server closed the stream without a response")
    }

    async fn notify(&self, method: &str) -> Result<()> {
        let msg = json!({"jsonrpc": "2.0", "method": method});
        match &self.transport {
            Transport::Stdio { .. } => self.send_line(&msg).await,
            Transport::Http { .. } => self.http_post(&msg, None, Duration::from_secs(15)).await.map(|_| ()),
        }
    }

    async fn send_line(&self, msg: &Value) -> Result<()> {
        let Transport::Stdio { stdin, .. } = &self.transport else { unreachable!() };
        let mut line = serde_json::to_vec(msg)?;
        line.push(b'\n');
        let mut stdin = stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.flush().await?;
        Ok(())
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let msg = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        match &self.transport {
            Transport::Http { .. } => match tokio::time::timeout(timeout, self.http_post(&msg, Some(id), timeout)).await {
                Ok(r) => r?.ok_or_else(|| anyhow!("no response")),
                Err(_) => bail!("timed out after {}s", timeout.as_secs()),
            },
            Transport::Stdio { pending, .. } => {
                let (tx, rx) = oneshot::channel();
                pending.lock().unwrap().insert(id, tx);
                self.send_line(&msg).await?;
                match tokio::time::timeout(timeout, rx).await {
                    Ok(Ok(Ok(v))) => Ok(v),
                    Ok(Ok(Err(e))) => bail!("{e}"),
                    Ok(Err(_)) => bail!("server closed"),
                    Err(_) => {
                        pending.lock().unwrap().remove(&id);
                        bail!("timed out after {}s", timeout.as_secs())
                    }
                }
            }
        }
    }

    pub async fn list_tools(&self) -> Result<Vec<Value>> {
        let mut tools = vec![];
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(c) => json!({"cursor": c}),
                None => json!({}),
            };
            let r = self.request("tools/list", params, Duration::from_secs(15)).await?;
            tools.extend(r["tools"].as_array().cloned().unwrap_or_default());
            cursor = r["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                return Ok(tools);
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct Status {
    pub name: String,
    pub detail: String,
    pub tools: usize,
    pub ok: bool,
}

/// Connect to every configured server in parallel. Failures are reported, not fatal.
pub async fn connect_all(cwd: &Path, trusted: bool) -> (Vec<Arc<dyn Tool>>, Vec<Status>) {
    let servers = load_config(cwd, trusted);
    let results = futures::future::join_all(servers.into_iter().map(|(name, cfg)| async move {
        let r = async {
            let client = Client::connect(&cfg).await?;
            let tools = client.list_tools().await?;
            Ok::<_, anyhow::Error>((client, tools))
        }
        .await;
        (name, cfg, r)
    }))
    .await;
    let mut tools: Vec<Arc<dyn Tool>> = vec![];
    let mut status = vec![];
    for (name, cfg, r) in results {
        match r {
            Ok((client, list)) => {
                status.push(Status { name: name.clone(), detail: cfg.describe(), tools: list.len(), ok: true });
                for t in list {
                    let Some(tool_name) = t["name"].as_str() else { continue };
                    tools.push(Arc::new(McpTool {
                        full_name: leak(format!("mcp__{}__{}", sanitize(&name), sanitize(tool_name))),
                        tool: tool_name.to_owned(),
                        description: leak(t["description"].as_str().unwrap_or("").chars().take(1024).collect()),
                        schema: t.get("inputSchema").cloned().unwrap_or_else(|| json!({"type": "object"})),
                        read_only: t["annotations"]["readOnlyHint"].as_bool().unwrap_or(false),
                        client: client.clone(),
                    }));
                }
            }
            Err(e) => status.push(Status { name, detail: e.to_string(), tools: 0, ok: false }),
        }
    }
    (tools, status)
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// Tool names/descriptions live for the whole process; leaking keeps the Tool trait simple.
fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

pub struct McpTool {
    full_name: &'static str,
    tool: String,
    description: &'static str,
    schema: Value,
    read_only: bool,
    client: Arc<Client>,
}

impl Tool for McpTool {
    fn name(&self) -> &'static str {
        self.full_name
    }
    fn description(&self) -> &'static str {
        self.description
    }
    fn schema(&self) -> Value {
        self.schema.clone()
    }
    /// A server's own "read-only" hint isn't proof: such tools still ask in Ask and Plan mode (as web
    /// fetches do), they just aren't refused in Plan mode.
    fn access(&self) -> Access {
        if self.read_only { Access::Network } else { Access::Exec }
    }
    fn title(&self, input: &Value) -> String {
        crate::tools::compact_json(input, 80)
    }
    fn target(&self, _input: &Value) -> String {
        self.full_name.to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let call = self.client.request("tools/call", json!({"name": self.tool, "arguments": input}), Duration::from_secs(300));
            let r = tokio::select! {
                r = call => r,
                _ = ctx.cancel.cancelled() => return ToolOutput::err("interrupted"),
            };
            match r {
                Err(e) => ToolOutput::err(format!("MCP error: {e}")),
                Ok(v) => {
                    let mut content = vec![];
                    let mut text = String::new();
                    for c in v["content"].as_array().into_iter().flatten() {
                        match c["type"].as_str() {
                            Some("text") => {
                                let t = c["text"].as_str().unwrap_or("");
                                text.push_str(t);
                                text.push('\n');
                                content.push(ResultPart::Text { text: crate::tools::clip(t, 30_000) });
                            }
                            Some("image") => content.push(ResultPart::Image {
                                media_type: c["mimeType"].as_str().unwrap_or("image/png").into(),
                                data: c["data"].as_str().unwrap_or("").into(),
                            }),
                            _ => content.push(ResultPart::Text { text: c.to_string() }),
                        }
                    }
                    if content.is_empty() {
                        if let Some(sc) = v.get("structuredContent") {
                            content.push(ResultPart::Text { text: sc.to_string() });
                        }
                    }
                    let ok = !v["isError"].as_bool().unwrap_or(false);
                    let lines = text.lines().count();
                    ToolOutput { ok, summary: if ok { format!("{lines} lines") } else { "error".into() }, display: text.trim_end().to_owned(), content, diff: None }
                }
            }
        })
    }
}

// The test server is a shell script.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn talks_to_a_stdio_server() {
        // A tiny MCP server in shell: answers initialize, tools/list and tools/call by request id.
        let script = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"initialize"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"t","version":"1"}}}\n' "$id" ;;
    *'"tools/list"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echo","inputSchema":{"type":"object","properties":{"msg":{"type":"string"}}},"annotations":{"readOnlyHint":true}}]}}\n' "$id" ;;
    *'"tools/call"'*) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pong"}]}}\n' "$id" ;;
  esac
done"#;
        let cfg = ServerConfig { command: Some("sh".into()), args: vec!["-c".into(), script.into()], env: HashMap::new(), url: None, headers: HashMap::new(), kind: None };
        let client = Client::connect(&cfg).await.unwrap();
        let tools = client.list_tools().await.unwrap();
        assert_eq!(tools[0]["name"], "echo");
        let t = McpTool {
            full_name: "mcp__t__echo",
            tool: "echo".into(),
            description: "Echo",
            schema: tools[0]["inputSchema"].clone(),
            read_only: true,
            client,
        };
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _rx) = crate::tools::testutil::ctx(dir.path());
        let out = t.run(&ctx, json!({"msg": "ping"})).await;
        assert!(out.ok);
        assert_eq!(out.display, "pong");
        assert_eq!(t.access(), Access::Network);
    }
}

#[cfg(test)]
mod http_tests {
    use super::*;

    /// Streamable HTTP server: JSON for initialize (+ session id), 202 for notifications,
    /// SSE for tools/list (with a notification before the response), JSON for tools/call.
    async fn server(seen: Arc<Mutex<Vec<String>>>) -> String {
        use crate::tools::testutil::http::{Res, serve};
        let base = serve(move |req| {
            let msg = req.json();
            let method = msg["method"].as_str().unwrap_or("").to_owned();
            let session = req.header("mcp-session-id").unwrap_or_default();
            let auth = req.header("authorization").unwrap_or_default();
            seen.lock().unwrap().push(format!("{method}|{session}|{auth}"));
            let id = msg["id"].clone();
            match method.as_str() {
                "initialize" => Res {
                    headers: "mcp-session-id: sess-1\r\n".into(),
                    ..Res::new(200, "application/json", json!({"jsonrpc":"2.0","id":id,"result":{"protocolVersion":PROTOCOL,"capabilities":{"tools":{}}}}).to_string())
                },
                "notifications/initialized" => Res::new(202, "", ""),
                "tools/list" => Res::new(
                    200,
                    "text/event-stream",
                    format!(
                        "event: message\ndata: {}\n\nevent: message\ndata: {}\n\n",
                        json!({"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}),
                        json!({"jsonrpc":"2.0","id":id,"result":{"tools":[{"name":"search","description":"Search docs","inputSchema":{"type":"object"}}]}})
                    ),
                ),
                _ => Res::new(200, "application/json", json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"found 3 docs"}]}}).to_string()),
            }
        })
        .await;
        format!("{base}/mcp")
    }

    #[tokio::test]
    async fn streamable_http_with_session_and_sse() {
        let seen = Arc::new(Mutex::new(vec![]));
        let url = server(seen.clone()).await;
        // SAFETY: test-only env var read by expand_env below.
        unsafe { std::env::set_var("GOND_AGENT_TEST_MCP_TOKEN", "s3cret") };
        let cfg = ServerConfig {
            command: None,
            args: vec![],
            env: HashMap::new(),
            url: Some(url),
            headers: HashMap::from([("Authorization".into(), "Bearer ${GOND_AGENT_TEST_MCP_TOKEN}".into())]),
            kind: Some("http".into()),
        };
        let client = Client::connect(&cfg).await.unwrap();
        let tools = client.list_tools().await.unwrap();
        assert_eq!(tools[0]["name"], "search");
        let r = client.request("tools/call", json!({"name":"search","arguments":{}}), Duration::from_secs(5)).await.unwrap();
        assert_eq!(r["content"][0]["text"], "found 3 docs");
        let seen = seen.lock().unwrap().clone();
        assert_eq!(
            seen,
            vec![
                "initialize||bearer s3cret",
                "notifications/initialized|sess-1|bearer s3cret",
                "tools/list|sess-1|bearer s3cret",
                "tools/call|sess-1|bearer s3cret",
            ]
        );
    }

    #[test]
    fn expands_env_and_describes() {
        // SAFETY: test-only env var.
        unsafe { std::env::set_var("GOND_AGENT_TEST_X", "abc") };
        assert_eq!(expand_env("a ${GOND_AGENT_TEST_X} b ${GOND_AGENT_TEST_MISSING_VAR}c ${GOND_AGENT_TOKEN} ${open"), "a abc b c  ${open");
        let cfg = ServerConfig {
            command: Some("npx".into()),
            args: vec!["srv".into()],
            env: HashMap::from([("A_KEY".into(), "1".into())]),
            url: None,
            headers: HashMap::new(),
            kind: None,
        };
        assert_eq!(cfg.describe(), "npx srv (env: A_KEY)");
    }
}
