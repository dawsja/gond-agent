// Real loopback HTTP, with the backoff clock explicitly controlled.
use super::*;
use crate::api::wire::{Message, Metadata};
use crate::tools::testutil::http::{Res, serve};

fn request() -> ResponsesRequest {
    ResponsesRequest { model:"m".into(), system:None, messages:vec![Message::user_text("work")], tools:vec![], max_output_tokens:None, reasoning:None, metadata:Metadata::default() }
}

#[test]
fn full_jitter_and_server_minimum_are_bounded() {
    let base = Duration::from_secs(2);
    assert_eq!(retry_delay(base, 1, 0.0, None), Duration::ZERO);
    assert_eq!(retry_delay(base, 1, 1.0, None), Duration::from_secs(2));
    assert_eq!(retry_delay(base, 4, 0.5, None), Duration::from_secs(8));
    assert_eq!(retry_delay(base, 10, 1.0, None), Duration::from_secs(60));
    assert_eq!(retry_delay(base, 1, 1.0, Some(900_000)), Duration::from_secs(120));
    let now = httpdate::parse_http_date("Wed, 21 Oct 2015 07:27:00 GMT").unwrap();
    assert_eq!(retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now), Some(60_000));
    assert_eq!(retry_after("999", now), Some(120_000));
    assert_eq!(retry_after("-1", now), None);
    assert_eq!(retry_after("invalid", now), None);
}

#[tokio::test]
async fn retry_after_is_honoured_with_a_fake_clock() {
    let attempts = Arc::new(AtomicU32::new(0));
    let count = attempts.clone();
    let url = serve(move |_| {
        if count.fetch_add(1, Ordering::SeqCst) == 0 {
            Res { headers:"retry-after: 20\r\n".into(), ..Res::new(429, "application/json", r#"{"error":{"code":"provider_rate_limit","retryable":true}}"#) }
        } else { Res::new(200, "text/event-stream", "event: response.end\ndata: {}\n\n") }
    }).await;
    let api = ApiClient::new(url, None);
    let mut stream = api.responses(&request()).await.unwrap();
    assert!(matches!(stream.next().await.unwrap().unwrap(), StreamEvent::Retry { attempt:2, wait_seconds:20.0, .. }));
    tokio::time::pause();
    let mut next = Box::pin(stream.next());
    assert!(futures::poll!(next.as_mut()).is_pending());
    tokio::time::advance(Duration::from_secs(19)).await;
    assert!(futures::poll!(next.as_mut()).is_pending());
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_secs(1)).await;
    tokio::time::resume();
    assert!(matches!(next.await.unwrap().unwrap(), StreamEvent::End { .. }));
    assert_eq!(attempts.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_permanent_failure_after_retries_retains_the_true_attempt_count() {
    let attempts = Arc::new(AtomicU32::new(0));
    let count = attempts.clone();
    let url = serve(move |_| {
        if count.fetch_add(1, Ordering::SeqCst) < 2 {
            Res::new(503, "application/json", r#"{"error":{"code":"provider_unavailable","retryable":true}}"#)
        } else { Res::new(401, "application/json", r#"{"error":{"code":"provider_auth","retryable":false}}"#) }
    }).await;
    let api = ApiClient::new(url, None).with_retry_delay(Duration::ZERO);
    let mut stream = api.responses(&request()).await.unwrap();
    for next_attempt in [2, 3] {
        assert!(matches!(stream.next().await.unwrap().unwrap(), StreamEvent::Retry { attempt, .. } if attempt == next_attempt));
    }
    let error = stream.next().await.unwrap().unwrap_err();
    let error = error.downcast_ref::<ApiError>().unwrap();
    assert_eq!((error.code.as_str(), error.attempts, error.retryable), ("provider_auth", 3, false));
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn permanent_http_failures_and_context_overflow_never_retry() {
    for (status, code) in [(401,"provider_auth"), (402,"provider_quota"), (400,"provider_request"), (400,"context_exceeded"), (429,"chatgpt_usage_limit"), (429,"provider_usage_limit")] {
        let attempts = Arc::new(AtomicU32::new(0));
        let count = attempts.clone();
        let url = serve(move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            Res::new(status, "application/json", serde_json::json!({"error":{"code":code,"retryable":true,"message":"secret"}}).to_string())
        }).await;
        let api = ApiClient::new(url, None).with_retry_delay(Duration::ZERO);
        let mut stream = api.responses(&request()).await.unwrap();
        let error = stream.next().await.unwrap().unwrap_err();
        let error = error.downcast_ref::<ApiError>().unwrap();
        assert_eq!(error.code, code);
        assert_eq!(error.attempts, 1);
        assert!(!error.retryable);
        assert!(!error.message.contains("secret"));
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
    }
}
