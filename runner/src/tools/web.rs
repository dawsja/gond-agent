//! web_fetch: reads a page from the web, locally.

use std::sync::OnceLock;
use std::time::Duration;

use futures::future::BoxFuture;
use regex::Regex;
use serde_json::{Value, json};

use super::{Tool, ToolCtx, ToolOutput, clip, schema, str_arg};
use crate::permissions::Access;

const MAX_CHARS: usize = 60_000;
const MAX_BYTES: usize = 5 * 1024 * 1024;

/// The host a fetch of `url` really goes to, as the HTTP client parses it (lowercase, no port), for rules.
fn host(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_ascii_lowercase)).unwrap_or_default()
}

/// Blocks link-local / cloud metadata endpoints (169.254.0.0/16, fe80::/10, 0.0.0.0, metadata.google.internal).
fn is_blocked_host(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url) else { return true };
    let Some(raw) = u.host_str() else { return true };
    let trimmed = raw.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = trimmed.parse::<std::net::IpAddr>() {
        return match ip {
            std::net::IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || v4.is_multicast(),
            std::net::IpAddr::V6(v6) => {
                v6.is_unspecified()
                    || v6.is_multicast()
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
                    || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast())
            }
        };
    }
    let d = raw.trim_end_matches('.').to_ascii_lowercase();
    d.is_empty() || d == "metadata.google.internal" || d == "instance-data"
}

fn redirect_policy(origin: String) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |a| {
        if a.previous().len() >= 5 {
            a.error("too many redirects")
        } else if !is_blocked_host(a.url().as_str()) && a.url().host_str().map(str::to_ascii_lowercase).as_deref() == Some(origin.as_str()) {
            a.follow()
        } else {
            a.stop()
        }
    })
}

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).expect("valid regex"))
}

fn decode_entities(s: &str) -> String {
    static NUM: OnceLock<Regex> = OnceLock::new();
    let s = re(&NUM, r"&#(x?[0-9a-fA-F]+);").replace_all(s, |c: &regex::Captures| {
        let v = &c[1];
        let n = if let Some(h) = v.strip_prefix('x').or_else(|| v.strip_prefix('X')) { u32::from_str_radix(h, 16).ok() } else { v.parse().ok() };
        n.and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&amp;", "&")
}

/// HTML → readable text with markdown-ish headings, list items and links.
pub fn html_to_text(html: &str) -> (Option<String>, String) {
    static TITLE: OnceLock<Regex> = OnceLock::new();
    static DROP: OnceLock<[Regex; 6]> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    static HEAD: OnceLock<Regex> = OnceLock::new();
    static LI: OnceLock<Regex> = OnceLock::new();
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static GAPS: OnceLock<Regex> = OnceLock::new();
    let title = re(&TITLE, r"(?is)<title[^>]*>(.*?)</title>").captures(html).map(|c| decode_entities(c[1].trim()));
    let drop = DROP.get_or_init(|| {
        ["script", "style", "noscript", "svg", "head", "template"].map(|t| Regex::new(&format!(r"(?is)<{t}\b.*?</{t}>")).unwrap())
    });
    let mut s = html.to_owned();
    for r in drop {
        s = r.replace_all(&s, "").into_owned();
    }
    s = re(&LINK, r#"(?is)<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a>"#)
        .replace_all(&s, |c: &regex::Captures| {
            let text = c[2].trim();
            if text.is_empty() || c[1].starts_with('#') || c[1].starts_with("javascript:") { text.to_owned() } else { format!("[{text}]({})", &c[1]) }
        })
        .into_owned();
    s = re(&HEAD, r"(?i)<h([1-6])[^>]*>").replace_all(&s, |c: &regex::Captures| format!("\n\n{} ", "#".repeat(c[1].parse().unwrap_or(2)))).into_owned();
    s = re(&LI, r"(?i)<li[^>]*>").replace_all(&s, "\n- ").into_owned();
    s = re(&BLOCK, r"(?i)<br\s*/?>|</(p|div|section|article|h[1-6]|tr|ul|ol|pre|blockquote|table)>").replace_all(&s, "\n").into_owned();
    s = re(&TAG, r"(?s)<[^>]+>").replace_all(&s, "").into_owned();
    let s = decode_entities(&s);
    let lines: Vec<&str> = s.lines().map(str::trim).collect();
    let joined = lines.join("\n");
    let text = re(&GAPS, r"\n{3,}").replace_all(&joined, "\n\n").trim().to_owned();
    (title, text)
}

pub struct WebFetch;

impl Tool for WebFetch {
    fn name(&self) -> &'static str {
        "web_fetch"
    }
    fn description(&self) -> &'static str {
        "Fetch a URL and return its content as readable text (HTML is converted; JSON and text are returned as-is). Use for documentation and pages the user links. Results are capped at 60k characters."
    }
    fn schema(&self) -> Value {
        schema(json!({"url": {"type": "string", "description": "http(s) URL"}}), &["url"])
    }
    fn access(&self) -> Access {
        Access::Network
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "url").unwrap_or("?").to_owned()
    }
    fn target(&self, input: &Value) -> String {
        host(str_arg(input, "url").unwrap_or(""))
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(url) = str_arg(&input, "url") else { return ToolOutput::err("url is required") };
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return ToolOutput::err("only http(s) URLs can be fetched");
            }
            if is_blocked_host(url) {
                return ToolOutput::err("that host cannot be fetched");
            }
            let client = crate::http::builder()
                .timeout(Duration::from_secs(30))
                // A rule allows one host: redirects elsewhere aren't followed (the answer says where).
                .redirect(redirect_policy(host(url)))
                .user_agent(concat!("gond-agent/", env!("CARGO_PKG_VERSION"), " (+https://gond.io/agent)"))
                .build()
                .expect("http client");
            let req = client.get(url).header("accept", "text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5").send();
            let res = tokio::select! {
                r = req => r,
                _ = ctx.cancel.cancelled() => return ToolOutput::err("interrupted"),
            };
            let mut res = match res {
                Ok(r) => r,
                Err(e) => return ToolOutput::err(format!("fetch failed: {e}")),
            };
            let status = res.status();
            if status.is_redirection() {
                let to = res.headers().get("location").and_then(|v| v.to_str().ok()).unwrap_or("?");
                return ToolOutput::err(format!("{status}: redirects to another site, {to}. Fetch that URL to follow it."));
            }
            let final_url = res.url().to_string();
            let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
            let mut bytes = Vec::new();
            loop {
                let chunk = tokio::select! {
                    c = res.chunk() => c,
                    _ = ctx.cancel.cancelled() => return ToolOutput::err("interrupted"),
                };
                match chunk {
                    Ok(Some(c)) => {
                        let take = c.len().min(MAX_BYTES.saturating_sub(bytes.len()));
                        bytes.extend_from_slice(&c[..take]);
                        if bytes.len() >= MAX_BYTES {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(e) => return ToolOutput::err(format!("fetch failed: {e}")),
                }
            }
            let kb = bytes.len() / 1024;
            if !(ctype.is_empty() || ctype.contains("text") || ctype.contains("json") || ctype.contains("xml") || ctype.contains("javascript")) {
                return ToolOutput::err(format!("{status}: {ctype} content ({kb} KB) can't be shown as text"));
            }
            let raw = String::from_utf8_lossy(&bytes);
            let (title, body) = if ctype.contains("html") || raw.trim_start().starts_with('<') { html_to_text(&raw) } else { (None, raw.into_owned()) };
            let mut text = String::new();
            if final_url != url {
                text.push_str(&format!("(redirected to {final_url})\n"));
            }
            if let Some(t) = &title {
                text.push_str(&format!("# {t}\n\n"));
            }
            text.push_str(&clip(&body, MAX_CHARS));
            let mut out = if status.is_success() { ToolOutput::ok(text, format!("{} · {kb} KB", status.as_u16())) } else { ToolOutput::err(format!("HTTP {status}\n{text}")) };
            out.display = title.unwrap_or_default();
            out
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_html() {
        let html = r#"<html><head><title>Hono &amp; Workers</title><style>x{}</style></head><body>
<script>alert(1)</script><h1>Middleware</h1><p>Use <a href="https://hono.dev/docs">the docs</a>.<br>Next&nbsp;line</p>
<ul><li>one</li><li>two &#x2713;</li></ul></body></html>"#;
        let (title, text) = html_to_text(html);
        assert_eq!(title.as_deref(), Some("Hono & Workers"));
        assert_eq!(text, "# Middleware\nUse [the docs](https://hono.dev/docs).\nNext line\n\n- one\n- two ✓");
        assert_eq!(host("https://user@Docs.rs:8443/x?y"), "docs.rs");
        // A backslash ends the host for the HTTP client, so the rule must see evil.com too.
        assert_eq!(host("https://evil.com\\@docs.rs/x"), "evil.com");
        assert_eq!(host("not a url"), "");
        assert!(is_blocked_host("http://169.254.169.254/latest/meta-data/"));
        assert!(is_blocked_host("http://metadata.google.internal/computeMetadata/v1/"));
        assert!(is_blocked_host("http://0.0.0.0:8080/"));
        assert!(!is_blocked_host("http://127.0.0.1:8787/"));
        assert!(!is_blocked_host("https://gond.io/agent/docs"));
    }
}
