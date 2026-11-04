// Behavioral evidence uses the real dispatcher, file tools, exec path and a scripted model.
fn sub_results(req: &Value) -> &Vec<Value> { req["messages"][2]["content"].as_array().unwrap() }
fn sub_text(block: &Value) -> &str { block["content"][0]["text"].as_str().unwrap() }
fn delegate(kind: &str, id: &str) -> Value {
    json!({"type":"tool_call","id":id,"name":"task","input":{
        "kind":kind,"description":"Independent bounded task","prompt":"Task: prevent division by zero. Review current git diff or calculate.py; write regression tests if requested."
    }})
}

#[tokio::test]
async fn bounded_reviewer_seeded_diff_and_fifth_call_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| std::process::Command::new("git").args(args).current_dir(dir.path()).output().unwrap();
    assert!(git(&["init"]).status.success());
    std::fs::write(dir.path().join("calculate.py"), "def divide(a, b):\n    return 0 if b == 0 else a / b\n").unwrap();
    assert!(git(&["add", "calculate.py"]).status.success());
    // Diff against the index needs neither a commit nor a configured identity.
    std::fs::write(dir.path().join("calculate.py"), "def divide(a, b):\n    return a / b\n").unwrap();
    let seen = Arc::new(StdMutex::new(vec![]));
    let handler: Handler = Arc::new(|req| {
        let main = req["metadata"]["agent_id"] == "main";
        let count = req["messages"].as_array().unwrap().len();
        let first = count == 1;
        if main && count == 5 { return sse(&[delegate("reviewer", "followup-review")], "tool_use"); }
        if main && count == 7 {
            let last = &req["messages"][6]["content"][0];
            assert_eq!(last["is_error"], true);
            assert!(sub_text(last).contains("call limit"));
            return sse(&[json!({"type":"text","text":"Follow-up bounded"})], "end_turn");
        }
        match (main, first) {
            (true, true) => sse(&(1..=5).map(|n| delegate("reviewer", &format!("review{n}"))).collect::<Vec<_>>(), "tool_use"),
            (true, false) => {
                let results = sub_results(req);
                assert_eq!(results.len(), 5);
                for block in &results[..4] {
                    assert!(!block["is_error"].as_bool().unwrap_or(false));
                    assert!(sub_text(block).contains("calculate.py"));
                    assert!(sub_text(block).contains("changes_required"));
                }
                assert_eq!(results[4]["is_error"], true);
                assert!(sub_text(&results[4]).contains("call limit"));
                println!("Reviewer runtime: {}", sub_text(&results[0]));
                println!("Fifth call runtime: {}", sub_text(&results[4]));
                sse(&[json!({"type":"text","text":"Review received"})], "end_turn")
            }
            (false, true) => {
                let names: Vec<_> = req["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
                assert!(!names.contains(&"task") && !names.contains(&"bash") && !names.contains(&"write") && !names.contains(&"web_fetch"));
                assert_eq!(req["max_output_tokens"], subagents::MAX_OUTPUT_TOKENS);
                assert!(req["system"].as_str().unwrap().contains("findings"));
                sse(&[json!({"type":"tool_call","id":"diff","name":"git","input":{"action":"diff"}})], "tool_use")
            }
            (false, false) => {
                let diff = sub_text(&sub_results(req)[0]);
                assert!(diff.contains("-    return 0 if b == 0 else a / b"));
                assert!(diff.contains("+    return a / b"));
                sse(&[json!({"type":"text","text":"{\"findings\":[{\"file\":\"calculate.py\",\"line\":2,\"severity\":\"high\",\"message\":\"The changed division raises ZeroDivisionError when b is zero.\"}],\"verdict\":\"changes_required\"}"})], "end_turn")
            }
        }
    });
    let url = mock(handler, seen.clone()).await;
    let mut cfg = config(dir.path(), Mode::Allow); cfg.context_window = 200_000;
    let mut h = spawn(ApiClient::new(url, None), cfg);
    h.input.send(AgentInput::User { text:"Review the division change".into(), images:vec![] }).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd {agent_id,..} if agent_id == "main")).await;
    assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::AgentSpawn {..})).count(), 4);
    let mut active = 0;
    for e in &events {
        match e { AgentEvent::AgentSpawn {..} => { active += 1; assert!(active <= subagents::MAX_CONCURRENT); }, AgentEvent::AgentEnd {..} => active -= 1, _ => {} }
    }
    assert_eq!(active, 0);
    // Allowance is run-scoped, not reset for a follow-up turn.
    h.input.send(AgentInput::User {text:"Follow up".into(), images:vec![]}).unwrap();
    let followup = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd {agent_id,..} if agent_id == "main")).await;
    assert!(!followup.iter().any(|e| matches!(e, AgentEvent::AgentSpawn {..})));
}

#[tokio::test]
async fn bounded_test_writer_scope_depth_and_real_test_execution() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("containers")).unwrap();
    std::fs::write(dir.path().join("production.py"), "keep\n").unwrap();
    std::fs::write(dir.path().join("calculate.py"), "def divide(a, b):\n    return 0 if b == 0 else a / b\n").unwrap();
    let handler: Handler = Arc::new(|req| {
        let n = req["messages"].as_array().unwrap().len();
        if req["metadata"]["agent_id"] == "main" {
            if n == 1 { return sse(&[delegate("test_writer", "tests")], "tool_use"); }
            assert!(sub_text(&sub_results(req)[0]).contains("test_divide.py"));
            return sse(&[json!({"type":"text","text":"Done"})], "end_turn");
        }
        match n {
            1 => sse(&[
                json!({"type":"tool_call","id":"outside","name":"write","input":{"path":"production.py","content":"bad"}}),
                json!({"type":"tool_call","id":"patch","name":"apply_patch","input":{"patch":"*** Begin Patch\n*** Add File: containers/test_allowed.py\n+pass\n*** Add File: production.py\n+bad\n*** End Patch"}}),
                json!({"type":"tool_call","id":"nested","name":"task","input":{"kind":"reviewer","description":"Escape depth","prompt":"spawn again"}}),
                json!({"type":"tool_call","id":"exec-escape","name":"run_checks","input":{"command":"npm test; touch escaped"}}),
                json!({"type":"tool_call","id":"test","name":"write","input":{"path":"containers/test_divide.py","content":"import unittest\nfrom calculate import divide\nclass DivisionTest(unittest.TestCase):\n    def test_zero(self):\n        self.assertEqual(divide(1, 0), 0)\n        self.assertEqual(divide(6, 2), 3)\n"}}),
            ], "tool_use"),
            3 => {
                let r = sub_results(req);
                for block in &r[..4] { assert_eq!(block["is_error"], true); }
                println!("Write scope runtime: {}", sub_text(&r[0]));
                println!("Mixed patch runtime: {}", sub_text(&r[1]));
                println!("Depth runtime: {}", sub_text(&r[2]));
                println!("Exec injection runtime: {}", sub_text(&r[3]));
                assert!(!r[4]["is_error"].as_bool().unwrap_or(false));
                sse(&[json!({"type":"tool_call","id":"run-tests","name":"run_checks","input":{"command":"python3 -m unittest discover -s containers -p 'test_*.py'"}})], "tool_use")
            }
            _ => {
                let r = &req["messages"][4]["content"][0];
                assert!(!r["is_error"].as_bool().unwrap_or(false));
                assert!(sub_text(r).contains("Ran 1 test"));
                println!("Test execution runtime: {}", sub_text(r));
                sse(&[json!({"type":"text","text":"{\"added\":[\"containers/test_divide.py: zero case\"],\"results\":[\"unittest: exit 0, 1 test passed\"]}"})], "end_turn")
            }
        }
    });
    let url = mock(handler, Arc::new(StdMutex::new(vec![]))).await;
    let mut cfg = config(dir.path(), Mode::Allow); cfg.context_window = 200_000;
    let mut h = spawn(ApiClient::new(url, None), cfg);
    h.input.send(AgentInput::User {text:"Write tests".into(),images:vec![]}).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd {agent_id,..} if agent_id == "main")).await;
    assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::AgentSpawn {..})).count(), 1);
    assert_eq!(std::fs::read_to_string(dir.path().join("production.py")).unwrap(), "keep\n");
    assert!(!dir.path().join("containers/test_allowed.py").exists());
    assert!(!dir.path().join("escaped").exists());
    assert!(dir.path().join("containers/test_divide.py").exists());
}

#[tokio::test]
async fn bounded_children_inherit_plan_and_ask_permissions() {
    for mode in [Mode::Plan, Mode::Ask] {
        let dir = tempfile::tempdir().unwrap();
        let handler: Handler = Arc::new(|req| {
            let first = req["messages"].as_array().unwrap().len() == 1;
            match (req["metadata"]["agent_id"] == "main", first) {
                (true,true) => sse(&[delegate("test_writer", "tests")], "tool_use"),
                (false,true) => sse(&[
                    json!({"type":"tool_call","id":"w","name":"write","input":{"path":"containers/test_blocked.py","content":"no"}}),
                    json!({"type":"tool_call","id":"e","name":"run_checks","input":{"command":"npm test"}}),
                ], "tool_use"),
                (false,false) => {
                    assert!(sub_results(req).iter().all(|r| r["is_error"] == true));
                    sse(&[json!({"type":"text","text":"{\"added\":[],\"results\":[\"permission denied\"]}"})], "end_turn")
                }
                _ => sse(&[json!({"type":"text","text":"Done"})], "end_turn"),
            }
        });
        let url = mock(handler, Arc::new(StdMutex::new(vec![]))).await;
        let mut cfg = config(dir.path(), mode); cfg.context_window = 200_000;
        let mut h = spawn(ApiClient::new(url, None), cfg);
        h.input.send(AgentInput::User {text:"Test".into(),images:vec![]}).unwrap();
        let mut permissions = 0;
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), h.events.recv()).await.unwrap().unwrap();
            match ev {
                AgentEvent::PermissionRequest { request_id, agent_id, .. } => {
                    assert_eq!(mode, Mode::Ask); assert!(agent_id.starts_with("test_writer")); permissions += 1;
                    h.input.send(AgentInput::PermissionReply {request_id,decision:Decision::Deny,message:None}).unwrap();
                }
                AgentEvent::TurnEnd {agent_id,..} if agent_id == "main" => break,
                _ => {}
            }
        }
        assert_eq!(permissions, if mode == Mode::Ask {2} else {0});
        assert!(!dir.path().join("containers/test_blocked.py").exists());
    }
    assert_eq!(inherited_mode(Mode::Allow, Some(Mode::Plan)), Mode::Plan);
    assert_eq!(inherited_mode(Mode::Allow, Some(Mode::Ask)), Mode::Ask);
}

#[tokio::test]
async fn bounded_child_round_cap_and_parent_cancellation() {
    for interrupt in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let handler: Handler = Arc::new(|req| {
            if req["metadata"]["agent_id"] == "main" {
                return if req["messages"].as_array().unwrap().len() == 1 { sse(&[delegate("reviewer", "r")], "tool_use") }
                else { sse(&[json!({"type":"text","text":"Done"})], "end_turn") };
            }
            let n = req["messages"].as_array().unwrap().len();
            sse(&[json!({"type":"tool_call","id":format!("read-{n}"),"name":"read","input":{"path":"missing"}})], "tool_use")
        });
        let url = mock(handler, Arc::new(StdMutex::new(vec![]))).await;
        let mut cfg = config(dir.path(), Mode::Allow); cfg.context_window = 200_000;
        let mut h = spawn(ApiClient::new(url, None), cfg);
        h.input.send(AgentInput::User {text:"Review".into(),images:vec![]}).unwrap();
        if interrupt {
            until(&mut h, |e| matches!(e, AgentEvent::AgentSpawn {..})).await;
            h.input.send(AgentInput::Interrupt).unwrap();
        }
        let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd {agent_id,..} if agent_id == "main")).await;
        assert!(events.iter().any(|e| matches!(e, AgentEvent::AgentEnd {ok:false,..})));
        if !interrupt {
            assert_eq!(events.iter().filter(|e| matches!(e, AgentEvent::ToolCall {agent_id,..} if agent_id != "main")).count(), subagents::MAX_ROUNDS as usize);
        }
    }
}

#[tokio::test]
async fn bounded_depth_and_deadline_are_runtime_guards() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (_socket, _) = listener.accept().await.unwrap();
        std::future::pending::<()>().await;
    });
    let s = compaction_shared(ApiClient::new(url, None), 200_000);
    let input = json!({"description":"Check guard","prompt":"Review diff","kind":"reviewer"});
    let cancel = CancellationToken::new();
    let sub = Run { id:"reviewer-1".into(), kind:Some(SubagentKind::Reviewer), inherited_mode:Some(Mode::Allow) };
    let nested = task(&s, &sub, "nested".into(), "task".into(), &input, &cancel).await;
    assert!(matches!(nested, Block::ToolResult {is_error:true, ..}));
    assert_eq!(s.sub_counter.load(Ordering::Relaxed), 0, "depth check happens before budget consumption");
    let main = Run { id:"main".into(), kind:None, inherited_mode:None };
    for queued in [false, true] {
        let _permits = if queued { Some(s.sub_slots.acquire_many(2).await.unwrap()) } else { None };
        let block = tokio::time::timeout(Duration::from_secs(2), task_with_budget(&s, &main, "deadline".into(), "task".into(), &input, &cancel, Duration::from_millis(10))).await.unwrap();
        let Block::ToolResult {is_error, content, ..} = block else { panic!("expected result") };
        assert!(is_error);
        assert!(matches!(&content[0], ResultPart::Text {text} if text.contains("wall-clock limit")));
    }
    assert_eq!(s.sub_slots.available_permits(), 2);
    server.abort();
}

#[tokio::test]
async fn bounded_tool_call_and_provider_output_caps() {
    for oversized_output in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let handler: Handler = Arc::new(move |req| {
            if req["metadata"]["agent_id"] == "main" {
                return if req["messages"].as_array().unwrap().len() == 1 { sse(&[delegate("reviewer", "r")], "tool_use") }
                else {
                    let result = &sub_results(req)[0];
                    assert_eq!(result["is_error"], true);
                    assert!(sub_text(result).contains(if oversized_output { "response-byte limit" } else { "tool-call limit" }));
                    sse(&[json!({"type":"text","text":"Limit respected"})], "end_turn")
                };
            }
            if oversized_output {
                sse(&[json!({"type":"text","text":"x".repeat(subagents::MAX_RESPONSE_BYTES + 1)})], "end_turn")
            } else {
                sse(&(0..=subagents::MAX_TOOL_CALLS).map(|n| json!({"type":"tool_call","id":format!("r{n}"),"name":"read","input":{"path":"missing"}})).collect::<Vec<_>>(), "tool_use")
            }
        });
        let url = mock(handler, Arc::new(StdMutex::new(vec![]))).await;
        let mut cfg = config(dir.path(), Mode::Allow); cfg.context_window = 200_000;
        let mut h = spawn(ApiClient::new(url, None), cfg);
        h.input.send(AgentInput::User {text:"Review".into(),images:vec![]}).unwrap();
        let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd {agent_id,..} if agent_id == "main")).await;
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::ToolStart {agent_id,..} if agent_id != "main")));
    }
}

#[tokio::test]
async fn bounded_permission_wait_cannot_outlive_a_switch_to_plan() {
    let dir = tempfile::tempdir().unwrap();
    let handler: Handler = Arc::new(|req| {
        match (req["metadata"]["agent_id"] == "main", req["messages"].as_array().unwrap().len() == 1) {
            (true, true) => sse(&[delegate("test_writer", "t")], "tool_use"),
            (false, true) => sse(&[json!({"type":"tool_call","id":"w","name":"write","input":{"path":"containers/test_mode.py","content":"no"}})], "tool_use"),
            (false, false) => {
                assert_eq!(sub_results(req)[0]["is_error"], true);
                assert!(sub_text(&sub_results(req)[0]).contains("became stricter"));
                sse(&[json!({"type":"text","text":"{\"added\":[],\"results\":[\"mode changed\"]}"})], "end_turn")
            }
            _ => sse(&[json!({"type":"text","text":"Done"})], "end_turn"),
        }
    });
    let url = mock(handler, Arc::new(StdMutex::new(vec![]))).await;
    let mut cfg = config(dir.path(), Mode::Ask); cfg.context_window = 200_000;
    let mut h = spawn(ApiClient::new(url, None), cfg);
    h.input.send(AgentInput::User {text:"Write tests".into(),images:vec![]}).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::PermissionRequest {..})).await;
    let AgentEvent::PermissionRequest {request_id,..} = events.last().unwrap() else { unreachable!() };
    h.input.send(AgentInput::Mode {mode:Mode::Plan}).unwrap();
    h.input.send(AgentInput::PermissionReply {request_id:request_id.clone(),decision:Decision::AllowOnce,message:None}).unwrap();
    until(&mut h, |e| matches!(e, AgentEvent::TurnEnd {agent_id,..} if agent_id == "main")).await;
    assert!(!dir.path().join("containers/test_mode.py").exists());
}
