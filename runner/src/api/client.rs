use std::pin::Pin;
use std::sync::{Arc, RwLock};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use anyhow::Result;
use futures::{Stream, StreamExt};
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::wire::{ResponsesRequest, StreamEvent};

/// For responses without an API error body (a proxy page, an outage).
fn status_message(status: u16) -> &'static str {
    match status {
        401 => "You're signed out.",
        403 => "You don't have access to that.",
        404 => "Gond Agent couldn't find that.",
        429 => "Gond Agent is busy right now. Try again in a moment.",
        500.. => "Gond Agent is having trouble right now. Try again in a moment.",
        _ => "Something went wrong talking to Gond Agent. Try again in a moment.",
    }
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub status: Option<u16>,
}

impl ApiError {
    pub(crate) fn context_overflow(&self) -> bool {
        let code = self.code.to_ascii_lowercase();
        let message = self.message.to_ascii_lowercase();
        // Token wording also occurs in rate/quota and output limits. Only explicit
        // context codes or HTTP 400 context wording enter compaction, never 429.
        if self.status == Some(429) || code.contains("rate_limit") || code.contains("ratelimit") || code.contains("quota")
            || ["max_tokens", "max_output_tokens", "max_completion_tokens"].iter().any(|part| code.contains(part) || message.contains(part)) {
            return false;
        }
        matches!(code.as_str(), "context_exceeded" | "context_length_exceeded" | "model_context_window_exceeded" | "prompt_too_long" | "max_context_length_exceeded")
            || (self.status == Some(400) && ["maximum context", "context length", "context window", "prompt is too long", "prompt length exceeds"].iter().any(|part| message.contains(part)))
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}
impl std::error::Error for ApiError {}

pub type EventStream = Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>;
pub(crate) const SUMMARY_REQUEST_LIMIT: &str = "Too much history to summarise in one pass. Choose a model with a larger context window.";

fn connection_dropped() -> anyhow::Error {
    ApiError { code: "stream".into(), message: "The connection to the model dropped. Try again.".into(), retryable: true, status: None }.into()
}

fn model_retryable(error: &anyhow::Error) -> bool {
    if let Some(error) = error.downcast_ref::<ApiError>() {
        return error.retryable && !error.context_overflow();
    }
    error.downcast_ref::<reqwest::Error>().is_some_and(|error| {
        error.is_connect() || error.is_timeout() || error.is_request() || error.is_body()
    })
}

#[derive(Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    base: String,
    retry_delay: Duration,
    /// Shared authentication for internal requests.
    token: Arc<RwLock<Option<String>>>,
}

impl ApiClient {
    pub fn new(base: impl Into<String>, token: Option<String>) -> Self {
        let http = crate::http::builder().connect_timeout(Duration::from_secs(15)).build().expect("http client");
        ApiClient { http, base: base.into().trim_end_matches('/').to_owned(), retry_delay: Duration::from_secs(1), token: Arc::new(RwLock::new(token)) }
    }

    #[cfg(test)]
    pub(crate) fn with_retry_delay(mut self, delay: Duration) -> Self {
        self.retry_delay = delay;
        self
    }

    /// A short message for people, never internals: API errors as the API words them, network and
    /// protocol failures as plain sentences.
    pub fn describe(&self, e: &anyhow::Error) -> String {
        if let Some(a) = e.downcast_ref::<ApiError>() {
            return a.message.clone();
        }
        if let Some(r) = e.downcast_ref::<reqwest::Error>() {
            if r.is_timeout() {
                return "Gond Agent took too long to respond. Try again in a moment.".into();
            }
            if r.is_connect() || r.is_request() {
                return "Can't reach Gond Agent. Check your internet connection and try again.".into();
            }
            return "Something went wrong talking to Gond Agent. Try again in a moment.".into();
        }
        e.to_string()
    }

    fn req(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut r = self.http.request(method, format!("{}{}", self.base, path));
        if let Some(t) = self.token.read().ok().and_then(|t| t.clone()) {
            r = r.bearer_auth(t);
        }
        r
    }

    async fn check(res: reqwest::Response) -> Result<reqwest::Response> {
        if res.status().is_success() {
            return Ok(res);
        }
        let status = res.status().as_u16();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        let e = &body["error"];
        Err(ApiError {
            status: Some(status),
            code: e["code"].as_str().unwrap_or(if status == 401 { "unauthorized" } else { "http_error" }).into(),
            message: e["message"].as_str().map(str::to_owned).unwrap_or_else(|| status_message(status).into()),
            retryable: e["retryable"].as_bool().unwrap_or(status == 429 || status >= 500),
        }
        .into())
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let res = self.req(reqwest::Method::GET, path).timeout(Duration::from_secs(30)).send().await?;
        Ok(Self::check(res).await?.json().await?)
    }

    /// Retry the identical model request until response.end, at most three attempts (1s/2s backoff).
    /// Start resets the consumer's message assembly between attempts. Callers MUST defer tool
    /// execution until End: a partial tool call is only model output, never permission to execute.
    /// Dropping this stream cancels both an in-flight request and any pending backoff.
    pub async fn responses(&self, request: &ResponsesRequest) -> Result<EventStream> {
        self.responses_with_budget(request, None).await
    }

    /// Summary chunks/merges share a cap which includes every underlying HTTP retry.
    pub(crate) async fn responses_with_budget(&self, request: &ResponsesRequest, budget: Option<Arc<AtomicU32>>) -> Result<EventStream> {
        let api = self.clone();
        let request = Arc::new(request.clone());
        let stream = futures::stream::unfold((None::<EventStream>, 0u32, false), move |(mut stream, mut attempts, finished)| {
            let api = api.clone();
            let request = request.clone();
            let budget = budget.clone();
            async move {
                if finished { return None; }
                loop {
                    let next = if let Some(active) = &mut stream {
                        active.next().await
                    } else {
                        if budget.as_ref().is_some_and(|n| n.load(Ordering::Relaxed) == 0) {
                            return Some((Err(anyhow::anyhow!(SUMMARY_REQUEST_LIMIT)), (None, attempts, true)));
                        }
                        if attempts > 0 && !api.retry_delay.is_zero() {
                            tokio::time::sleep(api.retry_delay * (1 << (attempts - 1))).await;
                        }
                        if budget.as_ref().is_some_and(|n| n.try_update(Ordering::Relaxed, Ordering::Relaxed, |left| left.checked_sub(1)).is_err()) {
                            return Some((Err(anyhow::anyhow!(SUMMARY_REQUEST_LIMIT)), (None, attempts, true)));
                        }
                        attempts += 1;
                        match api.open_response(&request).await {
                            Ok(active) => { stream = Some(active); continue; }
                            Err(error) => Some(Err(error)),
                        }
                    };
                    let error = match next {
                        Some(Ok(StreamEvent::End { stop_reason, usage })) => {
                            return Some((Ok(StreamEvent::End { stop_reason, usage }), (None, attempts, true)));
                        }
                        Some(Ok(StreamEvent::Error { code, message, retryable })) => ApiError { code, message, retryable, status: None }.into(),
                        Some(Ok(event)) => return Some((Ok(event), (stream, attempts, false))),
                        Some(Err(error)) => error,
                        None => connection_dropped(),
                    };
                    if model_retryable(&error) {
                        if attempts < 3 {
                            // Discard the old HTTP body, decoder and pending events before retrying.
                            return Some((Ok(StreamEvent::Start), (None, attempts, false)));
                        }
                        let error = ApiError {
                            code: "model_connection_dropped".into(),
                            message: "The model connection dropped 3 times".into(),
                            retryable: true,
                            status: None,
                        };
                        return Some((Err(error.into()), (None, attempts, true)));
                    }
                    return Some((Err(error), (None, attempts, true)));
                }
            }
        });
        Ok(Box::pin(stream))
    }

    /// One HTTP attempt, without retrying or executing any model output.
    async fn open_response(&self, request: &ResponsesRequest) -> Result<EventStream> {
        let res = self.req(reqwest::Method::POST, "/v1/responses").json(request).send().await?;
        let res = Self::check(res).await?;
        let bytes = res.bytes_stream();
        let stream = futures::stream::unfold((bytes, SseDecoder::default(), Vec::<StreamEvent>::new()), |(mut bytes, mut dec, mut queue)| async move {
            loop {
                if !queue.is_empty() {
                    let ev = queue.remove(0);
                    return Some((Ok(ev), (bytes, dec, queue)));
                }
                match bytes.next().await {
                    Some(Ok(chunk)) => {
                        for (event, data) in dec.feed(&chunk) {
                            match StreamEvent::decode(&event, &data) {
                                Ok(Some(ev)) => {
                                    let terminal = matches!(ev, StreamEvent::End { .. } | StreamEvent::Error { .. });
                                    queue.push(ev);
                                    if terminal { break; }
                                }
                                Ok(None) => {}
                                Err(e) => return Some((Err(e), (bytes, dec, queue))),
                            }
                        }
                    }
                    // reqwest also labels truncated HTTP bodies as decode errors, not is_body().
                    // This is the byte transport boundary; malformed SSE/JSON above stays permanent.
                    Some(Err(_)) => return Some((Err(connection_dropped()), (bytes, dec, queue))),
                    None => return None,
                }
            }
        });
        Ok(Box::pin(stream))
    }
}

/// Incremental text/event-stream decoder. Yields (event, data) pairs; comments are skipped.
#[derive(Default)]
pub struct SseDecoder {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
}

impl SseDecoder {
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<(String, String)> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            let line = String::from_utf8_lossy(&line);
            if line.is_empty() {
                if !self.data.is_empty() {
                    out.push((std::mem::take(&mut self.event), self.data.join("\n")));
                    self.data.clear();
                }
                self.event.clear();
            } else if line.starts_with(':') {
                continue;
            } else {
                let (field, val) = line.split_once(':').unwrap_or((&line, ""));
                let val = val.strip_prefix(' ').unwrap_or(val);
                match field {
                    "event" => self.event = val.to_owned(),
                    "data" => self.data.push(val.to_owned()),
                    _ => {}
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn errors_read_as_plain_sentences() {
        // Nothing listens on port 9: a connection failure, worded for people (no hosts or settings).
        let api = ApiClient::new("http://127.0.0.1:9", None);
        let e = api.get::<Value>("/v1/me").await.unwrap_err();
        assert_eq!(api.describe(&e), "Can't reach Gond Agent. Check your internet connection and try again.");

        let signed_out: anyhow::Error = ApiError { code: "unauthorized".into(), message: "You're not signed in.".into(), retryable: false, status: Some(401) }.into();
        assert_eq!(api.describe(&signed_out), "You're not signed in.");
        assert_eq!(status_message(502), "Gond Agent is having trouble right now. Try again in a moment.");
    }

    #[tokio::test]
    async fn stream_retry_recovers_from_two_transport_body_aborts() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use super::super::wire::{Message, Metadata};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = ApiClient::new(format!("http://{}", listener.local_addr().unwrap()), None).with_retry_delay(Duration::ZERO);
        let server = tokio::spawn(async move {
            let mut bodies = Vec::new();
            for attempt in 0..3 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut received = Vec::new();
                let mut chunk = [0; 4096];
                let header_end = loop {
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(n, 0);
                    received.extend_from_slice(&chunk[..n]);
                    if let Some(index) = received.windows(4).position(|s| s == b"\r\n\r\n") { break index + 4; }
                };
                let headers = String::from_utf8_lossy(&received[..header_end]).to_lowercase();
                let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                while received.len() < header_end + length {
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert_ne!(n, 0);
                    received.extend_from_slice(&chunk[..n]);
                }
                bodies.push(received[header_end..header_end + length].to_vec());
                let body = if attempt < 2 {
                    "event: block.delta\ndata: {\"index\":0,\"text\":\"partial\"}\n\n"
                } else {
                    // Trailing failure must never replay a response that already completed.
                    "event: response.end\ndata: {}\n\nevent: error\ndata: {\"retryable\":true}\n\n"
                };
                let length = body.len() + if attempt < 2 { 100 } else { 0 };
                let response = format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {length}\r\nconnection: close\r\n\r\n{body}");
                socket.write_all(response.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            bodies
        });
        let request = ResponsesRequest {
            model: "m".into(), system: None, messages: vec![Message::user_text("work")], tools: vec![],
            max_output_tokens: None, reasoning: None, metadata: Metadata::default(),
        };
        let mut stream = api.responses(&request).await.unwrap();
        let events = tokio::time::timeout(Duration::from_secs(10), async {
            let mut events = Vec::new();
            while let Some(event) = stream.next().await { events.push(event.unwrap()); }
            events
        }).await.unwrap();
        assert_eq!(events.iter().filter(|e| matches!(e, StreamEvent::End { .. })).count(), 1);
        let bodies = server.await.unwrap();
        assert_eq!(bodies.len(), 3);
        assert!(bodies.windows(2).all(|pair| pair[0] == pair[1]));
    }

    #[test]
    fn decodes_split_chunks_and_skips_pings() {
        let text = b": ping\n\nevent: block.delta\ndata: {\"index\":0,\"text\":\"hi\"}\n\nevent: response.end\r\ndata: {}\r\n\r\n";
        let mut d = SseDecoder::default();
        let mut out = vec![];
        for c in text.chunks(5) {
            out.extend(d.feed(c));
        }
        assert_eq!(out, vec![("block.delta".into(), "{\"index\":0,\"text\":\"hi\"}".into()), ("response.end".into(), "{}".into())]);
    }
}
