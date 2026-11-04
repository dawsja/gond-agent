// Included in core's tests to exercise the real input dispatcher and local history.
fn export_command(id: &str) -> AgentInput {
    AgentInput::ExportState(ExportStateInput { request_id: id.into(), run_id: "run".into(), owner_id: "owner".into(), quiescent: None, boundary_id: None, hold: false })
}

fn import_command(id: &str, state: &Checkpoint) -> AgentInput {
    AgentInput::ImportState(ImportStateInput { request_id: id.into(), run_id: "run".into(), owner_id: "owner".into(), state: serde_json::to_value(state).unwrap() })
}

async fn exported(h: &mut AgentHandle, id: &str) -> Checkpoint {
    let events = until(h, |e| matches!(e, AgentEvent::StateExported { request_id, .. } if request_id == id)).await;
    let AgentEvent::StateExported { state, .. } = events.into_iter().last().unwrap() else { unreachable!() };
    *state
}

async fn ready(h: &mut AgentHandle) -> String {
    let events = until(h, |e| matches!(e, AgentEvent::CheckpointReady { .. })).await;
    let AgentEvent::CheckpointReady { boundary_id } = events.into_iter().last().unwrap() else { unreachable!() };
    boundary_id
}

fn release_command(id: &str) -> AgentInput {
    AgentInput::CheckpointRelease(super::super::events::CheckpointReleaseInput {
        request_id: format!("release-{id}"), boundary_id: id.into(),
    })
}

async fn held_state(h: &mut AgentHandle, boundary: &str) -> Checkpoint {
    h.input.send(AgentInput::ExportState(ExportStateInput {
        request_id: "held".into(), run_id: "run".into(), owner_id: "owner".into(),
        quiescent: None, boundary_id: Some(boundary.into()), hold: false,
    })).unwrap();
    exported(h, "held").await
}

#[tokio::test]
async fn checkpoint_holds_each_paired_round_and_keeps_pre_question_replay_point() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let url = mock(Arc::new(|req| {
        match req["messages"].as_array().unwrap().len() {
            1 => sse(&[json!({"type":"tool_call","id":"write","name":"write","input":{"path":"a.txt","content":"one"}})], "tool_use"),
            3 => sse(&[json!({"type":"tool_call","id":"question","name":"ask_user","input":{"question":"Choose?","options":[]}})], "tool_use"),
            _ => sse(&[json!({"type":"text","text":"Done"})], "end_turn"),
        }
    }), seen.clone()).await;
    let mut cfg = config(dir.path(), Mode::Allow);
    cfg.context_window = 100_000;
    let mut h = spawn(ApiClient::new(url, None), cfg);
    h.input.send(AgentInput::ExportState(ExportStateInput {
        request_id: "enable".into(), run_id: "run".into(), owner_id: "owner".into(),
        quiescent: Some(true), boundary_id: None, hold: false,
    })).unwrap();
    exported(&mut h, "enable").await;
    h.input.send(AgentInput::User { text: "Work".into(), images: vec![] }).unwrap();
    let initial = ready(&mut h).await;
    let state = held_state(&mut h, &initial).await;
    assert_eq!(state.history.len(), 1);
    assert!(seen.lock().unwrap().is_empty(), "model must wait for the initial capture");
    h.input.send(AgentInput::ExportState(ExportStateInput {
        request_id: "active-hold".into(), run_id: "run".into(), owner_id: "owner".into(),
        quiescent: Some(true), boundary_id: None, hold: true,
    })).unwrap();
    let rejected = until(&mut h, |e| matches!(e, AgentEvent::StateError { request_id, .. } if request_id == "active-hold")).await;
    assert!(matches!(rejected.last(), Some(AgentEvent::StateError { code, .. }) if code == "runner_not_idle"));
    h.input.send(release_command("stale")).unwrap();
    until(&mut h, |e| matches!(e, AgentEvent::StateError { operation, code, .. } if operation == "checkpoint.release" && code == "boundary_mismatch")).await;
    assert!(seen.lock().unwrap().is_empty());
    h.input.send(release_command(&initial)).unwrap();

    let written = ready(&mut h).await;
    let state = held_state(&mut h, &written).await;
    state.validate("run", "owner").unwrap();
    assert_eq!(state.history.len(), 3);
    assert_eq!(state.history.last().unwrap().role, Role::Tool);
    assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one");
    assert_eq!(seen.lock().unwrap().len(), 1, "next model must not run during capture");
    assert!(!serde_json::to_string(&state).unwrap().contains("Choose?"));
    assert!(h.events.try_recv().is_err(), "no tools or question may start while held");
    h.input.send(release_command(&written)).unwrap();
    let question = until(&mut h, |e| matches!(e, AgentEvent::Question { .. })).await;
    assert!(!question.iter().any(|e| matches!(e, AgentEvent::CheckpointReady { .. })), "unpaired question cannot replace the prior replay point");
    let AgentEvent::Question { request_id, .. } = question.into_iter().last().unwrap() else { unreachable!() };
    h.input.send(AgentInput::QuestionReply { request_id, answer: "Yes".into() }).unwrap();
    let answered = ready(&mut h).await;
    let state = held_state(&mut h, &answered).await;
    state.validate("run", "owner").unwrap();
    assert_eq!(state.history.len(), 5);
    assert_eq!(seen.lock().unwrap().len(), 2);
    h.input.send(release_command(&answered)).unwrap();
    let final_round = ready(&mut h).await;
    let state = held_state(&mut h, &final_round).await;
    assert_eq!(state.history.len(), 6);
    assert!(h.events.try_recv().is_err(), "turn.end must wait for persistence and release");
    h.input.send(release_command(&final_round)).unwrap();
    until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;

    // Publication can now change HEAD. Explicit idle capture holds the same
    // completed history without starting another turn/model request.
    h.input.send(AgentInput::ExportState(ExportStateInput {
        request_id: "idle-hold".into(), run_id: "run".into(), owner_id: "owner".into(),
        quiescent: Some(true), boundary_id: None, hold: true,
    })).unwrap();
    let idle = ready(&mut h).await;
    assert_ne!(idle, final_round);
    assert_eq!(exported(&mut h, "idle-hold").await, state);
    h.input.send(AgentInput::User { text: "Next turn".into(), images: vec![] }).unwrap();
    h.input.send(import_command("idle-barrier", &state)).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::StateError { request_id, .. } if request_id == "idle-barrier")).await;
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::TurnStart { .. })));
    assert_eq!(held_state(&mut h, &idle).await, state);
    h.input.send(release_command(&idle)).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::CheckpointReady { .. })).await;
    assert!(events.iter().any(|e| matches!(e, AgentEvent::TurnStart { .. })));
}

#[tokio::test]
async fn checkpoint_export_uses_stored_history_not_request_projection() {
    let dir = tempfile::tempdir().unwrap();
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::new_rgb8(2, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    let mut cfg = config(dir.path(), Mode::Allow);
    cfg.history = vec![Message { role: Role::User, content: (0..12).map(|_| Block::Image {
        media_type: "image/png".into(), data: data.clone(), id: None,
    }).collect() }];
    let expected = cfg.history.clone();
    let mut h = spawn(ApiClient::new("http://unused.invalid", None), cfg);
    h.input.send(export_command("images")).unwrap();
    let state = exported(&mut h, "images").await;
    assert_eq!(state.history, expected);
    assert_eq!(serde_json::to_string(&state).unwrap().matches("\"type\":\"image\"").count(), 12);
}

#[tokio::test]
async fn checkpoint_import_is_control_only_restores_counters_and_rejects_nonfresh_runner() {
    let dir = tempfile::tempdir().unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let url = mock(Arc::new(|_| sse(&[json!({"type":"text","text":"Done"})], "end_turn")), seen.clone()).await;
    let mut cfg = config(dir.path(), Mode::Allow);
    cfg.context_window = 100_000;
    cfg.history = vec![Message::user_text(format!("{SUMMARY_PREFIX}\nSaved notes"))];
    cfg.plan = vec![TodoItem { text: "Saved step".into(), status: super::super::events::TodoStatus::Done }];
    let mut original = spawn(ApiClient::new(url.clone(), None), cfg);
    original.input.send(export_command("first")).unwrap();
    let mut state = exported(&mut original, "first").await;
    state.counters = Counters { sub_counter: 9, main_context: 500, plan_calls: 17, plan_last: state.plan.clone(), plan_nudges: 1, turn_compactions: 2, skipped_history_len: None };
    let mut cfg = config(dir.path(), Mode::Allow);
    cfg.context_window = 100_000;
    let mut restored = spawn(ApiClient::new(url, None), cfg);
    restored.input.send(import_command("restore", &state)).unwrap();
    let events = until(&mut restored, |e| matches!(e, AgentEvent::StateImported { request_id } if request_id == "restore")).await;
    assert!(events.iter().all(|e| matches!(e, AgentEvent::SessionStart { .. } | AgentEvent::StateImported { .. })));
    restored.input.send(export_command("again")).unwrap();
    let mut expected = state.clone();
    // Restore deliberately advances its durable resume budget and records the
    // missing ignored-dependency caveat; all history, plans and counters survive.
    let ledger = expected.evidence.as_mut().unwrap();
    ledger.resumes += 1;
    ledger.unverified.push("Ignored files such as node_modules may be absent after restore.".into());
    assert_eq!(exported(&mut restored, "again").await, expected);
    restored.input.send(AgentInput::ExportState(ExportStateInput { request_id: "wrong-owner".into(), run_id: "run".into(), owner_id: "other".into(), quiescent: None, boundary_id: None, hold: false })).unwrap();
    let events = until(&mut restored, |e| matches!(e, AgentEvent::StateError { .. })).await;
    assert!(matches!(events.last(), Some(AgentEvent::StateError { request_id, code, .. }) if request_id == "wrong-owner" && code == "binding_mismatch"));
    restored.input.send(AgentInput::User { text: "Continue".into(), images: vec![] }).unwrap();
    // Sent immediately after user: import must fail at ingress, not wait until idle.
    restored.input.send(import_command("too-late", &state)).unwrap();
    let events = until(&mut restored, |e| matches!(e, AgentEvent::TurnEnd { .. })).await;
    // The dispatcher may reject before or after turn.end; explicitly await the ack if needed.
    if !events.iter().any(|e| matches!(e, AgentEvent::StateError { request_id, .. } if request_id == "too-late")) {
        let error = until(&mut restored, |e| matches!(e, AgentEvent::StateError { request_id, .. } if request_id == "too-late")).await;
        assert!(matches!(error.last(), Some(AgentEvent::StateError { code, .. }) if code == "runner_not_fresh"));
    } else {
        assert!(events.iter().any(|e| matches!(e, AgentEvent::StateError { code, .. } if code == "runner_not_fresh")));
    }
    assert_eq!(seen.lock().unwrap()[0]["messages"][0], serde_json::to_value(&state.history[0]).unwrap());
    restored.input.send(export_command("continued")).unwrap();
    let continued = exported(&mut restored, "continued").await;
    assert_eq!(continued.counters.sub_counter, 9);
    assert_eq!(continued.counters.plan_calls, 18);
    assert_eq!(continued.counters.plan_nudges, 1);
    assert_eq!(continued.counters.turn_compactions, 2);
}

#[tokio::test]
async fn checkpoint_waits_for_question_round_and_bounds_pending_exports() {
    for interrupt in [false, true] {
    let dir = tempfile::tempdir().unwrap();
    let url = mock(Arc::new(|req| {
        if req["messages"].as_array().unwrap().len() == 1 {
            sse(&[json!({"type":"tool_call","id":"question-call","name":"ask_user","input":{"question":"Choose?","options":[]}})], "tool_use")
        } else { sse(&[json!({"type":"text","text":"Done"})], "end_turn") }
    }), Arc::new(StdMutex::new(vec![]))).await;
    let mut cfg = config(dir.path(), Mode::Allow);
    cfg.context_window = 100_000;
    let mut h = spawn(ApiClient::new(url, None), cfg);
    h.input.send(AgentInput::User { text: "Work".into(), images: vec![] }).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::Question { .. })).await;
    let AgentEvent::Question { request_id, .. } = events.last().unwrap() else { unreachable!() };
    let question_id = request_id.clone();
    for i in 0..5 { h.input.send(export_command(&format!("export-{i}"))).unwrap(); }
    let events = until(&mut h, |e| matches!(e, AgentEvent::StateError { request_id, .. } if request_id == "export-4")).await;
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::StateExported { .. })));
    assert!(matches!(events.last(), Some(AgentEvent::StateError { code, .. }) if code == "export_queue_full"));
    // The queue-full reply is an ingress barrier; the question is still blocked.
    assert!(h.events.try_recv().is_err(), "must not snapshot an unpaired question call");
    if interrupt { h.input.send(AgentInput::Interrupt).unwrap(); }
    else { h.input.send(AgentInput::QuestionReply { request_id: question_id, answer: "Proceed".into() }).unwrap(); }
    let events = until(&mut h, |e| matches!(e, AgentEvent::StateExported { request_id, .. } if request_id == "export-3")).await;
    let states: Vec<_> = events.iter().filter_map(|e| match e { AgentEvent::StateExported { state, .. } => Some(state), _ => None }).collect();
    assert_eq!(states.len(), 4);
    for state in states {
        state.validate("run", "owner").unwrap();
        assert_eq!(state.history.last().unwrap().role, Role::Tool);
        let expected = if interrupt { "dismissed without an answer" } else { "Proceed" };
        assert!(serde_json::to_string(&state.history).unwrap().contains(expected));
        assert_eq!(Checkpoint::import(serde_json::to_value(state).unwrap(), "run", "owner").await.unwrap(), **state);
    }
    }
}

#[tokio::test]
async fn checkpoint_waits_for_complete_stream_and_paired_tool_results() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let (release_tx, release_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        // Read the request (not just its headers), so an unread body cannot reset TCP.
        let mut request = Vec::new();
        loop {
            let mut buf = [0; 4096];
            let n = socket.read(&mut buf).await.unwrap();
            assert_ne!(n, 0);
            request.extend_from_slice(&buf[..n]);
            if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..end]).to_lowercase();
                let len: usize = headers.lines().find_map(|l| l.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
                if request.len() >= end + 4 + len { break; }
            }
        }
        let partial = unfinished_response(&[
            json!({"type":"text","text":"Stream in progress"}),
            json!({"type":"tool_call","id":"complete-only","name":"list_plan","input":{}}),
        ]);
        let end = "event: response.end\ndata: {\"stop_reason\":\"tool_use\",\"usage\":{\"input_uncached\":1,\"output\":1,\"cache_read\":0,\"cache_write\":0}}\n\n";
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{partial}", partial.len() + end.len()).as_bytes()).await.unwrap();
        release_rx.await.unwrap();
        socket.write_all(end.as_bytes()).await.unwrap();
    });
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = config(dir.path(), Mode::Allow);
    cfg.context_window = 100_000;
    let mut h = spawn(ApiClient::new(url, None), cfg);
    h.input.send(AgentInput::User { text: "Work".into(), images: vec![] }).unwrap();
    until(&mut h, |e| matches!(e, AgentEvent::TextDelta { .. })).await;
    h.input.send(export_command("stream")).unwrap();
    // An invalid import is a deterministic ingress barrier while the stream is open.
    h.input.send(AgentInput::ImportState(ImportStateInput { request_id: "barrier".into(), run_id: "run".into(), owner_id: "owner".into(), state: json!({}) })).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::StateError { request_id, .. } if request_id == "barrier")).await;
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::StateExported { .. })));
    assert!(h.events.try_recv().is_err(), "must not export while the stream is blocked");
    release_tx.send(()).unwrap();
    let state = exported(&mut h, "stream").await;
    state.validate("run", "owner").unwrap();
    assert_eq!(state.history.len(), 3);
    assert_eq!(state.history.last().unwrap().role, Role::Tool);
    h.input.send(AgentInput::Interrupt).unwrap();
    server.await.unwrap();
}
