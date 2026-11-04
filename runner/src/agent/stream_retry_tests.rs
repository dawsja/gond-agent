// Included in core's test module to reuse the scripted model and real agent/tool harness.

fn unfinished_response(blocks: &[Value]) -> String {
    sse(blocks, "tool_use").split("event: response.end").next().unwrap().to_owned()
}

#[tokio::test]
async fn stream_retry_aborts_twice_then_executes_tools_once() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let attempts = Arc::new(AtomicU32::new(0));
    let count = attempts.clone();
    let url = mock(Arc::new(move |req: &Value| {
        if req["messages"].as_array().unwrap().len() > 1 {
            return sse(&[json!({"type":"text","text":"Finished"})], "end_turn");
        }
        let attempt = count.fetch_add(1, Ordering::SeqCst);
        if attempt < 2 {
            let mut body = unfinished_response(&[
                json!({"type":"text","text":"discarded partial reply"}),
                json!({"type":"tool_call","id":"discarded","name":"bash","input":{"command":"printf duplicate >> executions"}}),
            ]);
            // First attempt drops at EOF; second aborts with the relay's explicit retryable error.
            if attempt == 1 {
                body += "event: error\ndata: {\"code\":\"stream\",\"message\":\"The connection to the model dropped. Try again.\",\"retryable\":true}\n\n";
            }
            return body;
        }
        sse(&[json!({"type":"tool_call","id":"executed","name":"bash","input":{"command":"printf once >> executions"}})], "tool_use")
    }), seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None).with_retry_delay(std::time::Duration::ZERO), config(dir.path(), Mode::Allow));
    h.input.send(AgentInput::User { text: "work".into(), images: vec![] }).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert_eq!(std::fs::read_to_string(dir.path().join("executions")).unwrap(), "once");
    assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::ToolStart { .. })).count(), 1);
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })));
    assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::StreamReset { .. })).count(), 2);
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(requests[0], requests[1], "retry must send the identical request");
    assert_eq!(requests[1], requests[2]);
    assert!(!requests[3].to_string().contains("discarded"), "failed attempts cannot enter history");
}

#[tokio::test]
async fn stream_retry_five_drops_report_named_error_without_executing_partial_tools() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let url = mock(Arc::new(|_: &Value| unfinished_response(&[
        json!({"type":"tool_call","id":"never","name":"bash","input":{"command":"printf duplicate >> executions"}}),
    ])), seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None).with_retry_delay(std::time::Duration::ZERO), config(dir.path(), Mode::Allow));
    h.input.send(AgentInput::User { text: "work".into(), images: vec![] }).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::Error { .. })).await;
    assert_eq!(seen.lock().unwrap().len(), 5);
    assert!(matches!(events.last(), Some(AgentEvent::Error { code, attempts: 5, retryable: true, .. }) if code == "stream"));
    assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::Retry { .. })).count(), 4);
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::ToolStart { .. })));
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::StreamReset { .. })), "no visible output to reset");
    assert!(!dir.path().join("executions").exists());
}

#[tokio::test]
async fn stream_retry_respects_nonretryable_errors_after_partial_output() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let url = mock(Arc::new(|_: &Value| {
        let mut body = unfinished_response(&[json!({"type":"text","text":"partial"})]);
        body += "event: error\ndata: {\"code\":\"provider_quota\",\"message\":\"The provider quota is exhausted.\",\"retryable\":false}\n\n";
        body
    }), seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None), config(dir.path(), Mode::Allow));
    h.input.send(AgentInput::User { text: "work".into(), images: vec![] }).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::Error { .. })).await;
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(matches!(events.last(), Some(AgentEvent::Error { message, retryable: false, .. }) if message == "The provider account has no remaining credit or quota. Check billing with the provider."));
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::StreamReset { .. })), "terminal errors do not retry");
}

#[tokio::test]
async fn stream_retry_resets_only_partial_attempt_deltas_before_final_reply() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let attempts = Arc::new(AtomicU32::new(0));
    let count = attempts.clone();
    let url = mock(Arc::new(move |_: &Value| {
        match count.fetch_add(1, Ordering::SeqCst) {
            0 => unfinished_response(&[]), // A retry before output must not emit a reset.
            1 => {
                let mut body = unfinished_response(&[
                    json!({"type":"text","text":"🦀"}),
                    json!({"type":"text","text":"draft"}),
                ]);
                body += "event: block.start\ndata: {\"index\":2,\"type\":\"reasoning\"}\n\nevent: block.delta\ndata: {\"index\":2,\"text\":\"🤔\"}\n\n";
                body
            }
            _ => sse(&[json!({"type":"text","text":"Final reply"})], "end_turn"),
        }
    }), seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None).with_retry_delay(std::time::Duration::ZERO), config(dir.path(), Mode::Allow));
    h.input.send(AgentInput::User { text: "work".into(), images: vec![] }).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;
    let deltas: Vec<_> = events.iter().filter(|e| matches!(e,
        AgentEvent::TextDelta { .. } | AgentEvent::ReasoningDelta { .. } | AgentEvent::StreamReset { .. }
    )).cloned().collect();
    assert_eq!(deltas, vec![
        AgentEvent::TextDelta { agent_id: "main".into(), text: "🦀".into() },
        AgentEvent::TextDelta { agent_id: "main".into(), text: "draft".into() },
        AgentEvent::ReasoningDelta { agent_id: "main".into(), text: "🤔".into() },
        AgentEvent::StreamReset { agent_id: "main".into(), text_length: 7, reasoning_length: 2 },
        AgentEvent::TextDelta { agent_id: "main".into(), text: "Final reply".into() },
    ]);
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })));
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0], requests[1]);
    assert_eq!(requests[1], requests[2]);
}

#[tokio::test]
async fn stream_retry_and_in_turn_compaction_finish_with_final_text_once() {
    for reason in ["auto-round", "overflow"] {
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(StdMutex::new(vec![]));
        let main_attempts = Arc::new(AtomicU32::new(0));
        let summary_attempts = Arc::new(AtomicU32::new(0));
        let main_count = main_attempts.clone();
        let summary_count = summary_attempts.clone();
        let url = mock(Arc::new(move |req: &Value| {
            if is_summary(req) {
                return if summary_count.fetch_add(1, Ordering::Relaxed) == 0 {
                    unfinished_response(&[json!({"type":"text","text":"discarded summary"})])
                } else { sse(&[json!({"type":"text","text":"Earlier work"})], "end_turn") };
            }
            match main_count.fetch_add(1, Ordering::Relaxed) {
                0 => unfinished_response(&[
                    json!({"type":"text","text":"discarded main"}),
                    json!({"type":"tool_call","id":"discarded","name":"bash","input":{"command":"printf duplicate >> executions"}}),
                ]),
                1 => {
                    let reply = sse(&[json!({"type":"tool_call","id":"executed","name":"bash","input":{"command":"printf once >> executions"}})], "tool_use");
                    if reason == "auto-round" { reply.replace("\"input_uncached\":100", "\"input_uncached\":8000") } else { reply }
                }
                2 if reason == "overflow" => "event: error\ndata: {\"code\":\"context_exceeded\",\"message\":\"maximum context length\",\"retryable\":true}\n\n".into(),
                _ => sse(&[json!({"type":"text","text":"Final reply"})], "end_turn"),
            }
        }), seen.clone()).await;
        let mut cfg = config(dir.path(), Mode::Allow);
        cfg.context_window = 8192;
        cfg.history = (0..7).map(|n| Message::user_text(format!("Earlier {n} ").repeat(100))).collect();
        let mut h = spawn(ApiClient::new(url, None).with_retry_delay(std::time::Duration::ZERO), cfg);
        h.input.send(AgentInput::User { text: "Continue".into(), images: vec![] }).unwrap();
        let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })), "{events:?}");
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::TurnStart { agent_id } if agent_id == "main")).count(), 1);
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::TurnEnd { agent_id, stop_reason } if agent_id == "main" && stop_reason == "end_turn")).count(), 1);
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::Compacted { agent_id, reason: actual, before, after } if agent_id == "main" && actual == reason && before > after)).count(), 1);
        for agent in ["main", "compact"] {
            assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::StreamReset { agent_id, .. } if agent_id == agent)).count(), 1);
        }
        let mut text: Vec<u16> = vec![];
        for event in &events {
            match event {
                AgentEvent::TextDelta { agent_id, text: delta } if agent_id == "main" => text.extend(delta.encode_utf16()),
                AgentEvent::StreamReset { agent_id, text_length, .. } if agent_id == "main" => text.truncate(text.len() - text_length),
                _ => {}
            }
        }
        assert_eq!(String::from_utf16(&text).unwrap(), "Final reply");
        assert_eq!(std::fs::read_to_string(dir.path().join("executions")).unwrap(), "once");
        assert_eq!(main_attempts.load(Ordering::Relaxed), if reason == "overflow" { 4 } else { 3 });
        assert_eq!(summary_attempts.load(Ordering::Relaxed), 2);
        let requests = seen.lock().unwrap();
        assert_eq!(requests[0], requests[1], "transient retries keep the request identical");
        let last = requests.last().unwrap().to_string();
        assert!(last.contains("Earlier work"));
        assert!(!last.contains("discarded"), "aborted main/summary text cannot enter compacted history");
        assert_summary_bounds(&requests, 8192);
        eprintln!("combined retry/{reason} evidence: main and summary reset once; tool executes once; final reply once");
    }
}

#[tokio::test]
async fn stream_retry_interrupt_stops_pending_retry() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let url = mock(Arc::new(|_: &Value| unfinished_response(&[json!({"type":"text","text":"partial"})])), seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None), config(dir.path(), Mode::Allow));
    h.input.send(AgentInput::User { text: "work".into(), images: vec![] }).unwrap();
    until(&mut h, |e| matches!(e, AgentEvent::TextDelta { .. })).await;
    h.input.send(AgentInput::Interrupt).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;
    assert!(matches!(events.last(), Some(AgentEvent::TurnEnd { stop_reason, .. }) if stop_reason == "interrupted"));
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. } | AgentEvent::ToolStart { .. })));
}

#[tokio::test]
async fn server_errors_retry_only_model_requests_and_preserve_exhausted_cause() {
    use crate::tools::testutil::http::{Res, serve};
    for exhausted in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let attempts = Arc::new(AtomicU32::new(0));
        let counter = attempts.clone();
        let url = serve(move |_| {
            let n = counter.fetch_add(1, Ordering::SeqCst);
            if exhausted || n < 2 {
                Res::new(503, "application/json", r#"{"error":{"code":"provider_unavailable","message":"secret https://private.invalid","retryable":true}}"#)
            } else if n == 2 {
                Res::new(200, "text/event-stream", sse(&[json!({"type":"tool_call","id":"once","name":"bash","input":{"command":"printf once >> executions"}})], "tool_use"))
            } else {
                Res::new(200, "text/event-stream", sse(&[json!({"type":"text","text":"Done"})], "end_turn"))
            }
        }).await;
        let mut h = spawn(ApiClient::new(url, None).with_retry_delay(std::time::Duration::ZERO), config(dir.path(), Mode::Allow));
        h.input.send(AgentInput::User { text: "work".into(), images: vec![] }).unwrap();
        let events = until(&mut h, |e| if exhausted { matches!(e, AgentEvent::Error { .. }) } else { matches!(e, AgentEvent::TurnEnd { .. }) }).await;
        assert_eq!(attempts.load(Ordering::SeqCst), if exhausted { 5 } else { 4 });
        assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::Retry { class, .. } if class == "provider_unavailable")).count(), if exhausted { 4 } else { 2 });
        if exhausted {
            assert!(matches!(events.last(), Some(AgentEvent::Error { code, attempts:5, status:Some(503), message, .. }) if code == "provider_unavailable" && !message.contains("private.invalid")));
            assert!(!dir.path().join("executions").exists());
        } else {
            assert_eq!(std::fs::read_to_string(dir.path().join("executions")).unwrap(), "once");
            assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::ToolStart { .. })).count(), 1);
        }
    }
}

#[tokio::test]
async fn stop_interrupts_model_backoff_immediately() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let url = mock(Arc::new(|_| "event: error\ndata: {\"code\":\"provider_rate_limit\",\"retryable\":true,\"retry_after_ms\":120000}\n\n".into()), seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None), config(dir.path(), Mode::Allow));
    h.input.send(AgentInput::User { text:"work".into(), images:vec![] }).unwrap();
    until(&mut h, |e| matches!(e, AgentEvent::Retry { attempt:2, wait_seconds, .. } if *wait_seconds == 120.0)).await;
    h.input.send(AgentInput::Interrupt).unwrap();
    let events = tokio::time::timeout(std::time::Duration::from_secs(1), until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { .. }))).await.unwrap();
    assert!(matches!(events.last(), Some(AgentEvent::TurnEnd { stop_reason, .. }) if stop_reason == "interrupted"));
    assert_eq!(seen.lock().unwrap().len(), 1);
}
