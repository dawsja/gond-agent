use std::pin::Pin;
use std::sync::{Arc, RwLock};
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
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({})", self.message, self.code)
    }
}
impl std::error::Error for ApiError {}

pub type EventStream = Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>;

#[derive(Clone)]
pub struct ApiClient {
    http: reqwest::Client,
    base: String,
    /// Shared authentication for internal requests.
    token: Arc<RwLock<Option<String>>>,
}

impl ApiClient {
    pub fn new(base: impl Into<String>, token: Option<String>) -> Self {
        let http = crate::http::builder().connect_timeout(Duration::from_secs(15)).build().expect("http client");
        ApiClient { http, base: base.into().trim_end_matches('/').to_owned(), token: Arc::new(RwLock::new(token)) }
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

    /// POST /v1/responses and decode the SSE stream.
    pub async fn responses(&self, request: &ResponsesRequest) -> Result<EventStream> {
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
                                Ok(Some(ev)) => queue.push(ev),
                                Ok(None) => {}
                                Err(e) => return Some((Err(e), (bytes, dec, queue))),
                            }
                        }
                    }
                    Some(Err(e)) => return Some((Err(e.into()), (bytes, dec, queue))),
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

        let signed_out: anyhow::Error = ApiError { code: "unauthorized".into(), message: "You're not signed in.".into(), retryable: false }.into();
        assert_eq!(api.describe(&signed_out), "You're not signed in.");
        assert_eq!(status_message(502), "Gond Agent is having trouble right now. Try again in a moment.");
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
