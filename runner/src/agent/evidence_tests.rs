//! Fake-model integration tests. Included as a child module of core so these
//! exercise the real loop/dispatcher without exposing private runner state.
use super::*;
use std::collections::VecDeque;
use std::path::Path;
use std::time::Duration;

const BEFORE: &str = "module.exports = 1;\n";
const AFTER: &str = "module.exports = 1; // implementation changed\n";
const GATE: &str = "Evidence gate (transparency, not enforcement). Evidence recorded by the worker is missing or stale.\n\
Requirement CHECK: run one eligible exact command with run_checks; it must report more than zero tests and leave the tree unchanged.\n\
CHECK[1] command=\"npm test\" cwd=\".\"\n\
Alternatively call declare_unverified with a plain reason; it will always appear under Not verified. Do not claim independent proof.";

fn git(dir: &Path, args: &[&str]) {
    // Fixture-only identity/configuration: never touch this checkout or global
    // Git config, and never inherit relay credentials into fixture subprocesses.
    let output = std::process::Command::new("/usr/bin/git")
        .current_dir(dir)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Evidence fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
        .env("GIT_COMMITTER_NAME", "Evidence fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(output.status.success(), "fixture git command failed");
}

fn repository() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "--quiet", "--template="]);
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"private":true,"scripts":{"test":"node --test"}}"#,
    )
    .unwrap();
    std::fs::write(dir.path().join("source.js"), BEFORE).unwrap();
    std::fs::write(dir.path().join("source.test.js"),
        "const test = require('node:test');\nconst assert = require('node:assert/strict');\ntest('source returns one', () => assert.equal(require('./source.js'), 1));\n").unwrap();
    git(dir.path(), &["add", "."]);
    git(dir.path(), &["commit", "--quiet", "-m", "fixture base"]);
    dir
}

fn config(dir: &Path) -> AgentConfig {
    AgentConfig {
        model: "m".into(),
        context_window: 100_000,
        mode: Mode::Allow,
        rules: vec![],
        cwd: dir.into(),
        effort: "low".into(),
        session_id: "evidence-test".into(),
        history: vec![],
        plan: vec![],
        plan_reminder_every: 0,
        plan_nudge_limit: 0,
        interactive: false,
        question_wait: Duration::ZERO,
        tools: crate::tools::builtin(),
        system: "sys".into(),
        sub_system: "sub".into(),
        skills: vec![],
    }
}

// The relay's normalized SSE, not provider-specific OpenAI/Anthropic frames.
fn sse(blocks: &[Value], stop: &str) -> String {
    let mut body = String::from("event: response.start\ndata: {\"id\":\"r\",\"model\":\"m\"}\n\n");
    for (index, block) in blocks.iter().enumerate() {
        let kind = block["type"].as_str().unwrap();
        body += &format!(
            "event: block.start\ndata: {}\n\n",
            json!({
                "index":index, "type":kind, "id":block.get("id"), "name":block.get("name")
            })
        );
        if kind == "text" {
            body += &format!(
                "event: block.delta\ndata: {}\n\n",
                json!({"index":index,"text":block["text"]})
            );
            body += &format!("event: block.end\ndata: {}\n\n", json!({"index":index}));
        } else {
            body += &format!(
                "event: block.end\ndata: {}\n\n",
                json!({"index":index,"input":block["input"]})
            );
        }
    }
    body += &format!(
        "event: response.end\ndata: {}\n\n",
        json!({
            "stop_reason":stop,
            "usage":{"input_uncached":100,"output":20,"reasoning":0,"cache_read":0,"cache_write":0}
        })
    );
    body
}

fn call(id: &str, name: &str, input: Value) -> String {
    sse(
        &[json!({"type":"tool_call","id":id,"name":name,"input":input})],
        "tool_use",
    )
}

fn finish() -> String {
    sse(&[json!({"type":"text","text":"Finished."})], "end_turn")
}

fn editing_script() -> Vec<String> {
    vec![
        call("read-source", "read", json!({"path":"source.js"})),
        call(
            "edit-source",
            "edit",
            json!({"path":"source.js","old_string":BEFORE,"new_string":AFTER}),
        ),
        finish(),
    ]
}

async fn mock(script: Vec<String>, seen: Arc<Mutex<Vec<Value>>>) -> String {
    use crate::tools::testutil::http::{Res, serve};
    let script = Mutex::new(VecDeque::from(script));
    serve(move |request| {
        seen.lock().unwrap().push(request.json());
        let body = script.lock().unwrap().pop_front().unwrap_or_else(finish);
        Res::new(200, "text/event-stream", body)
    })
    .await
}

async fn until(h: &mut AgentHandle, pred: impl Fn(&AgentEvent) -> bool) -> Vec<AgentEvent> {
    let mut events = vec![];
    loop {
        let event = tokio::time::timeout(Duration::from_secs(30), h.events.recv())
            .await
            .expect("runner timed out")
            .expect("runner event stream closed");
        let done = pred(&event);
        events.push(event);
        if done {
            return events;
        }
    }
}

async fn turn(h: &mut AgentHandle) -> Vec<AgentEvent> {
    h.input
        .send(AgentInput::User {
            text: "Implement the change.".into(),
            images: vec![],
        })
        .unwrap();
    let events = until(
        h,
        |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main"),
    )
    .await;
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::Error { .. })));
    assert!(
        matches!(events.last(), Some(AgentEvent::TurnEnd { stop_reason, .. }) if stop_reason == "end_turn")
    );
    events
}

async fn exported(h: &mut AgentHandle) -> Checkpoint {
    h.input
        .send(AgentInput::ExportState(ExportStateInput {
            request_id: "export".into(),
            run_id: "run".into(),
            owner_id: "owner".into(),
        }))
        .unwrap();
    let events = until(h, |e| {
        matches!(
            e,
            AgentEvent::StateExported { .. } | AgentEvent::StateError { .. }
        )
    })
    .await;
    let AgentEvent::StateExported { state, .. } = events.into_iter().last().unwrap() else {
        panic!("checkpoint export failed");
    };
    *state
}

fn gate_count(history: &[Message]) -> usize {
    history
        .iter()
        .filter(|message| {
            message.content.iter().any(|block| {
        matches!(block, Block::Text { text, .. } if text.starts_with("Evidence gate ("))
    })
        })
        .count()
}

fn assert_gate_request(request: &Value) {
    let message = request["messages"].as_array().unwrap().last().unwrap();
    assert_eq!(
        message["role"], "user",
        "gate must not impersonate a system/tool message"
    );
    assert_eq!(message["content"][0]["text"], GATE);
    assert!(!request["system"].as_str().unwrap().contains(GATE));
}

#[tokio::test]
async fn changed_tree_finish_gates_then_exact_npm_test_records_real_evidence() {
    let dir = repository();
    let before = evidence_tree::tree_hash(dir.path()).unwrap();
    let mut script = editing_script();
    script.push(call(
        "checks",
        "run_checks",
        json!({"command":"npm test","timeout_ms":20_000}),
    ));
    script.push(finish());
    let seen = Arc::new(Mutex::new(vec![]));
    let url = mock(script, seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None), config(dir.path()));
    let events = turn(&mut h).await;
    assert!(events.iter().any(
        |e| matches!(e, AgentEvent::ToolEnd { call_id, ok:true, .. } if call_id == "edit-source")
    ));
    let records: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::EvidenceRecorded { record } => Some(record),
            _ => None,
        })
        .collect();
    assert_eq!(records.len(), 1);
    let record = records[0];
    let tree = evidence_tree::tree_hash(dir.path()).unwrap();
    assert_ne!(before, tree);
    assert_eq!(record.command, "npm test");
    assert_eq!(record.cwd, ".");
    assert_eq!(record.exit_code, Some(0));
    assert_eq!(
        record.tests_ran,
        Some(1),
        "must parse an actual node:test summary"
    );
    assert!(record.env_clean && record.successful_check() && record.fresh(&tree));
    let state = exported(&mut h).await;
    let ledger = state.evidence.as_ref().unwrap();
    assert_eq!(ledger.gate_rounds, 1);
    assert!(ledger.unverified.is_empty());
    assert_eq!(gate_count(&state.history), 1);
    assert_eq!(ledger.records.len(), 1);
    assert!(ledger.records[0] == *record);
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_gate_request(&requests[3]);
    let evidence_index = events
        .iter()
        .position(|e| matches!(e, AgentEvent::EvidenceRecorded { .. }))
        .unwrap();
    let end_index = events
        .iter()
        .position(|e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main"))
        .unwrap();
    assert!(evidence_index < end_index);
    // Safe, useful runtime evidence for --nocapture: no key, signature, token,
    // full checkpoint or untrusted command output is printed.
    println!(
        "Evidence gate runtime: {}",
        json!({
            "gate_message":GATE,"command":record.command,"exit_code":record.exit_code,
            "tests_ran":record.tests_ran,"fresh":record.fresh(&tree)
        })
    );
}

#[tokio::test]
async fn repeated_finish_is_bounded_at_two_gates_and_keeps_private_unverified_notes() {
    let dir = repository();
    let mut script = editing_script();
    script.extend([finish(), finish()]);
    let seen = Arc::new(Mutex::new(vec![]));
    let url = mock(script, seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None), config(dir.path()));
    let events = turn(&mut h).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::EvidenceRecorded { .. }))
    );
    let state = exported(&mut h).await;
    let ledger = state.evidence.as_ref().unwrap();
    assert_eq!(ledger.turn_gate_rounds, 2);
    assert_eq!(ledger.gate_rounds, 2);
    assert_eq!(gate_count(&state.history), 2);
    assert!(
        ledger
            .unverified
            .iter()
            .any(|note| note.contains("positive parsed test count"))
    );
    assert!(
        ledger
            .unverified
            .iter()
            .any(|note| note.contains("budget was exhausted"))
    );
    assert!(
        !serde_json::to_string(&state.history)
            .unwrap()
            .contains("budget was exhausted")
    );
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_gate_request(&requests[3]);
    assert_gate_request(&requests[4]);
}

#[tokio::test]
async fn declare_unverified_after_one_gate_finishes_and_preserves_the_reason() {
    let dir = repository();
    let mut script = editing_script();
    script.push(call(
        "declare",
        "declare_unverified",
        json!({"reason":"Cannot run dependencies offline."}),
    ));
    script.push(finish());
    let seen = Arc::new(Mutex::new(vec![]));
    let url = mock(script, seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None), config(dir.path()));
    let events = turn(&mut h).await;
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::EvidenceRecorded { .. }))
    );
    let state = exported(&mut h).await;
    let ledger = state.evidence.as_ref().unwrap();
    assert!(ledger.declared);
    assert_eq!(ledger.turn_gate_rounds, 1);
    assert_eq!(gate_count(&state.history), 1);
    assert!(
        ledger
            .unverified
            .iter()
            .any(|note| note == "Declared unverified: Cannot run dependencies offline.")
    );
    let requests = seen.lock().unwrap();
    assert_eq!(requests.len(), 5);
    assert_gate_request(&requests[3]);
}

#[tokio::test]
async fn unchanged_turn_finishes_without_gate_or_evidence() {
    let dir = repository();
    let seen = Arc::new(Mutex::new(vec![]));
    let url = mock(vec![finish()], seen.clone()).await;
    let mut h = spawn(ApiClient::new(url, None), config(dir.path()));
    let events = turn(&mut h).await;
    let state = exported(&mut h).await;
    let ledger = state.evidence.as_ref().unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert_eq!(gate_count(&state.history), 0);
    assert_eq!(ledger.gate_rounds, 0);
    assert!(ledger.records.is_empty() && ledger.unverified.is_empty());
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, AgentEvent::EvidenceRecorded { .. }))
    );
}

fn shared(dir: &Path) -> Arc<Shared> {
    Arc::new(Shared {
        api: ApiClient::new("http://unused.invalid", None),
        events: unbounded_channel().0,
        pending: Mutex::default(),
        mode: Mutex::new(Mode::Allow),
        rules: Mutex::default(),
        model: Mutex::new(("m".into(), 100_000)),
        effort: Mutex::new("low".into()),
        tools: vec![],
        reads: ReadSet::default(),
        shells: Shells::default(),
        browser: BrowserSession::default(),
        baseline: Baseline::default(),
        plan: Mutex::default(),
        plan_reminder_every: 0,
        plan_nudge_limit: 0,
        cwd: dir.into(),
        session_id: "s".into(),
        system: String::new(),
        sub_system: String::new(),
        locks: Mutex::default(),
        turn_cancel: Mutex::new(CancellationToken::new()),
        interactive: false,
        question_wait: Duration::ZERO,
        sub_counter: AtomicU32::new(0),
        main_context: Mutex::new(0),
        skills: Mutex::default(),
        checkpoints: CheckpointControl::default(),
        evidence: Mutex::new(evidence::Ledger::new(dir)),
    })
}

#[tokio::test]
async fn subagent_reserved_state_tools_are_hidden_and_direct_dispatch_is_forbidden() {
    let dir = repository();
    let shared = shared(dir.path());
    let original = shared.evidence.lock().unwrap().clone();
    let cancel = CancellationToken::new();
    for kind in ["general", "explore"] {
        let run = Run {
            id: format!("{kind}-1"),
            kind: Some(kind.into()),
        };
        for name in ["declare_unverified", "declare_task", "skip_repro"] {
            assert!(!agent_tool_defs(true).iter().any(|tool| tool.name == name));
            let block = run_call(
                &shared,
                Turn {
                    run: &run,
                    cancel: &cancel,
                    started: Instant::now(),
                    tool_count: 0,
                },
                format!("forbidden-{name}"),
                name.into(),
                json!({"reason":"skip checks"}),
            )
            .await;
            let Block::ToolResult {
                is_error, content, ..
            } = block
            else {
                panic!("expected tool result")
            };
            assert!(is_error);
            assert!(content.iter().any(|part| matches!(part, ResultPart::Text { text } if text.contains("unavailable to subagents"))));
        }
    }
    assert!(
        agent_tool_defs(false)
            .iter()
            .any(|tool| tool.name == "declare_unverified")
    );
    assert!(
        *shared.evidence.lock().unwrap() == original,
        "forbidden calls must not mutate ledger"
    );
}

fn checkpoint_fixture(dir: &Path) -> Checkpoint {
    Checkpoint {
        schema_version: checkpoint::SCHEMA_VERSION,
        runner_state_version: checkpoint::RUNNER_STATE_VERSION.into(),
        run_id: "run".into(),
        owner_id: "owner".into(),
        history: vec![Message::user_text("Saved task")],
        plan: vec![],
        counters: Counters::default(),
        evidence: Some(evidence::Ledger::new(dir)),
    }
}

fn signed_record(ledger: &mut evidence::Ledger, tree: &str) -> evidence::Record {
    ledger
        .record(evidence::Record {
            seq: 0,
            id: String::new(),
            command: "npm test".into(),
            cwd: ".".into(),
            exit_code: Some(0),
            duration_ms: 10,
            started_at: 1,
            tree_hash_before: tree.into(),
            tree_hash_after: tree.into(),
            tests_ran: Some(1),
            env_clean: true,
            env_digest: evidence::environment_digest(),
            output_tail: "# tests 1\n# pass 1\n# fail 0\n".into(),
            kind: evidence::EvidenceKind::Check,
            sig: String::new(),
        })
        .unwrap()
}

async fn restore(dir: &Path, value: Value) -> Checkpoint {
    let mut h = spawn(ApiClient::new("http://unused.invalid", None), config(dir));
    h.input
        .send(AgentInput::ImportState(ImportStateInput {
            request_id: "restore".into(),
            run_id: "run".into(),
            owner_id: "owner".into(),
            state: value,
        }))
        .unwrap();
    let events = until(&mut h, |e| {
        matches!(
            e,
            AgentEvent::StateImported { .. } | AgentEvent::StateError { .. }
        )
    })
    .await;
    assert!(
        matches!(events.last(), Some(AgentEvent::StateImported { request_id }) if request_id == "restore")
    );
    assert!(events.iter().all(|e| matches!(
        e,
        AgentEvent::SessionStart { .. } | AgentEvent::StateImported { .. }
    )));
    exported(&mut h).await
}

#[tokio::test]
async fn checkpoint_roundtrip_restores_ledger_and_marks_mismatched_trees_stale() {
    let dir = repository();
    let base_tree = evidence_tree::tree_hash(dir.path()).unwrap();
    let mut state = checkpoint_fixture(dir.path());
    std::fs::write(dir.path().join("source.js"), AFTER).unwrap();
    let tree = evidence_tree::tree_hash(dir.path()).unwrap();
    let ledger = state.evidence.as_mut().unwrap();
    ledger.begin_turn(Some(base_tree), false);
    ledger.gate_rounds = 1;
    ledger.turn_gate_rounds = 1;
    ledger.fix_rounds = 2;
    ledger.reviews = 1;
    let record = signed_record(ledger, &tree);
    let value: Value = serde_json::from_slice(&checkpoint::json_bytes(&state).unwrap()).unwrap();
    let decoded = Checkpoint::import(value.clone(), "run", "owner")
        .await
        .unwrap();
    // Avoid assert_eq! on private checkpoint/ledger values: its debug output
    // would expose the signing key on failure.
    assert!(
        decoded == state,
        "checkpoint codec must preserve all ledger state"
    );
    let restored = restore(dir.path(), value.clone()).await;
    assert!(restored.history == state.history);
    let fresh = restored.evidence.as_ref().unwrap();
    assert!(fresh.records == state.evidence.as_ref().unwrap().records);
    assert!(fresh.key == state.evidence.as_ref().unwrap().key);
    assert!(fresh.stale_ids.is_empty());
    assert_eq!(fresh.resumes, 1);
    assert_eq!(
        (
            fresh.gate_rounds,
            fresh.turn_gate_rounds,
            fresh.fix_rounds,
            fresh.reviews
        ),
        (1, 1, 2, 1)
    );
    assert!(
        fresh
            .unverified
            .iter()
            .any(|note| note.contains("node_modules"))
    );
    let mut eligible = fresh.clone();
    assert!(eligible.gate(dir.path(), Some(&tree)).is_none());

    std::fs::write(dir.path().join("source.js"), "module.exports = 2;\n").unwrap();
    let changed_tree = evidence_tree::tree_hash(dir.path()).unwrap();
    let stale = restore(dir.path(), value).await;
    let mut ledger = stale.evidence.unwrap();
    assert_eq!(ledger.stale_ids, vec![record.id.clone()]);
    assert_eq!(
        ledger.records.len(),
        1,
        "retain historical evidence, do not delete or re-sign it"
    );
    assert!(ledger.records[0] == record);
    assert!(ledger.gate(dir.path(), Some(&changed_tree)).is_some());
    ledger.validate().unwrap();
}

#[tokio::test]
async fn old_checkpoint_without_ledger_and_missing_key_restore_without_trusting_history() {
    let dir = repository();
    let mut old = serde_json::to_value(checkpoint_fixture(dir.path())).unwrap();
    old.as_object_mut().unwrap().remove("evidence");
    old["runner_state_version"] = json!("gond-agent-checkpoint-1");
    let decoded = Checkpoint::import(old.clone(), "run", "owner")
        .await
        .unwrap();
    assert!(decoded.evidence.is_none());
    assert_eq!(
        decoded.runner_state_version,
        checkpoint::RUNNER_STATE_VERSION
    );
    let restored = restore(dir.path(), old).await;
    let ledger = restored.evidence.as_ref().unwrap();
    assert!(ledger.records.is_empty());
    assert!(
        ledger
            .unverified
            .iter()
            .any(|note| note.contains("predates the evidence ledger"))
    );

    let mut state = checkpoint_fixture(dir.path());
    let tree = evidence_tree::tree_hash(dir.path()).unwrap();
    let ledger = state.evidence.as_mut().unwrap();
    let record = signed_record(ledger, &tree);
    ledger.key = None;
    let restored = restore(dir.path(), serde_json::to_value(state).unwrap()).await;
    let ledger = restored.evidence.unwrap();
    assert!(ledger.key.is_some());
    assert_eq!(ledger.stale_ids, vec![record.id.clone()]);
    assert!(ledger.records[0] == record);
    assert!(
        ledger
            .unverified
            .iter()
            .any(|note| note.contains("before restart cannot satisfy"))
    );
    ledger.validate().unwrap();
}

#[test]
fn input_frames_keep_metadata_compatibility_but_checkpoint_controls_remain_exact() {
    let user = r#"{"type":"user","text":"Continue","effort":"high","metadata":{"source":"api"}}"#;
    assert_eq!(
        serde_json::from_str::<AgentInput>(user).unwrap(),
        AgentInput::User {
            text: "Continue".into(),
            images: vec![]
        }
    );
    assert_eq!(
        serde_json::from_str::<AgentInput>(r#"{"type":"interrupt","future_field":true}"#).unwrap(),
        AgentInput::Interrupt
    );
    let export = r#"{"type":"export_state","request_id":"r","run_id":"run","owner_id":"owner"}"#;
    let input: AgentInput = serde_json::from_str(export).unwrap();
    assert_eq!(serde_json::to_string(&input).unwrap(), export);
    let import =
        r#"{"type":"import_state","request_id":"r","run_id":"run","owner_id":"owner","state":{}}"#;
    let input: AgentInput = serde_json::from_str(import).unwrap();
    assert_eq!(serde_json::to_string(&input).unwrap(), import);
    for frame in [export, import] {
        let mut value: Value = serde_json::from_str(frame).unwrap();
        value["future_field"] = json!(true);
        assert!(serde_json::from_value::<AgentInput>(value).is_err());
    }
    assert!(
        serde_json::from_str::<AgentInput>(r#"{"type":"evidence.recorded","record":{}}"#).is_err()
    );
}
