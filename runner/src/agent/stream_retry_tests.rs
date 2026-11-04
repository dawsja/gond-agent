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
async fn stream_retry_three_drops_report_named_error_without_executing_partial_tools() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let url = mock(Arc::new(|_: &Value| unfinished_response(&[
        json!({"type":"tool_call","id":"never","name":"bash","input":{"command":"printf duplicate >> executions"}}),
    ])), seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None).with_retry_delay(std::time::Duration::ZERO), config(dir.path(), Mode::Allow));
    h.input.send(AgentInput::User { text: "work".into(), images: vec![] }).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::Error { .. })).await;
    assert_eq!(seen.lock().unwrap().len(), 3);
    assert!(matches!(events.last(), Some(AgentEvent::Error { message, retryable: true, .. }) if message == "The model connection dropped 3 times"));
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
    assert!(matches!(events.last(), Some(AgentEvent::Error { message, retryable: false, .. }) if message == "The provider quota is exhausted."));
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
