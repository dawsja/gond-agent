// Included in evidence_tests: real dispatcher, isolated fixture Git and local fake model.
#[test]
fn repro_reporters_reject_compile_import_syntax_and_pretest_errors() {
    use super::super::repro::classify;
    for runner in ["vitest", "jest", "pytest", "cargo", "go", "unsupported"] {
        for output in [
            "SyntaxError: unexpected token",
            "ImportError: broken import",
            "error[E0308]: wrong type\nerror: could not compile",
            "exit before tests",
            "AssertionError: not reporter output",
        ] {
            assert!(
                classify(runner, output, Some(101)).failed.is_empty(),
                "{runner}: {output}"
            );
        }
        for code in [124, 126, 127, 137] {
            assert!(
                classify(runner, "AssertionError: false", Some(code))
                    .failed
                    .is_empty()
            );
        }
    }
    for runner in ["vitest", "jest"] {
        let output = json!({"testResults":[{"name":"a.test.ts","assertionResults":[{"fullName":"regression","status":"failed","failureMessages":["AssertionError: expected 1 to be 2"]}]}]}).to_string();
        assert_eq!(
            classify(runner, &output, Some(1)).failed,
            ["a.test.ts::regression"]
        );
        assert!(
            classify(
                runner,
                &output.replace("AssertionError", "SyntaxError"),
                Some(1)
            )
            .failed
            .is_empty()
        );
        assert!(
            classify(
                runner,
                &output.replace("AssertionError", "ImportError: AssertionError"),
                Some(1)
            )
            .failed
            .is_empty()
        );
    }
    let runtime = json!({"testResults":[{"name":"a.test.ts","assertionResults":[{"fullName":"runtime","status":"failed","failureMessages":["TypeError: expected a callback"]}]}]}).to_string();
    assert!(classify("vitest", &runtime, Some(1)).failed.is_empty());
    let xml = r#"<testsuite><testcase classname="a" name="regression"><failure message="AssertionError">assert 1 == 2</failure></testcase></testsuite>"#;
    assert_eq!(classify("pytest", xml, Some(1)).failed, ["a::regression"]);
    assert!(
        classify("pytest", &xml.replace("failure", "error"), Some(1))
            .failed
            .is_empty()
    );
    let cargo = "running 1 test\nthread 'regression' (123) panicked at tests/repro.rs:1:1:\nassertion `left == right` failed\ntest regression ... FAILED\n";
    assert_eq!(classify("cargo", cargo, Some(101)).failed, ["regression"]);
    assert!(
        classify(
            "cargo",
            &(cargo.to_owned() + "error: could not compile"),
            Some(101)
        )
        .failed
        .is_empty()
    );
    let go = [json!({"Action":"output","Package":"tiny","Test":"TestRegression","Output":"    value_test.go:7: expected 2, got 1\n"}), json!({"Action":"fail","Package":"tiny","Test":"TestRegression"})].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    assert_eq!(
        classify("go", &go, Some(1)).failed,
        ["tiny::TestRegression"]
    );
    assert!(
        classify(
            "go",
            &go.replace("expected 2", "undefined: expected 2"),
            Some(1)
        )
        .failed
        .is_empty()
    );
}

fn repro_repository() -> tempfile::TempDir {
    let dir = repository();
    std::fs::write(
        dir.path().join("package.json"),
        r#"{"private":true,"scripts":{"test":"vitest run"}}"#,
    )
    .unwrap();
    std::fs::remove_file(dir.path().join("source.test.js")).unwrap();
    std::fs::write(dir.path().join(".gitignore"), "node_modules\n").unwrap();
    git(dir.path(), &["add", "--all"]);
    git(dir.path(), &["commit", "-qm", "vitest fixture base"]);
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../api/node_modules"),
        dir.path().join("node_modules"),
    )
    .unwrap();
    dir
}
const REPRO_TEST: &str = "import {test, expect} from 'vitest';\nimport value from './source.js';\ntest('regression returns two', () => expect(value).toBe(2));\n";

#[tokio::test]
async fn repro_fake_model_red_fix_green_and_sealed_resume_keep_order() {
    let dir = repro_repository();
    let script = vec![
        call(
            "declare",
            "declare_task",
            json!({"kind":"bug","repro_plan":"new assertion, red before fix"}),
        ),
        call(
            "test",
            "write",
            json!({"path":"regression.test.js","content":REPRO_TEST}),
        ),
        call(
            "red",
            "run_checks",
            json!({"repro":"red","test_files":["regression.test.js"]}),
        ),
        call(
            "fix",
            "bash",
            json!({"command":"printf 'module.exports = 2;\\n' > source.js"}),
        ),
        call(
            "green",
            "run_checks",
            json!({"repro":"green","test_files":["regression.test.js"]}),
        ),
        call("normal", "run_checks", json!({"command":"npm test"})),
        finish(),
    ];
    let seen = Arc::new(Mutex::new(vec![]));
    let url = mock(script, seen).await;
    let mut h = spawn(ApiClient::new(&url, None), config(dir.path()));
    let events = turn(&mut h).await;
    let records = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::EvidenceRecorded { record } => Some(record),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(records.len(), 3, "events: {events:?}");
    let evidence::EvidenceKind::ReproRed { test_id, cases, .. } = &records[0].kind else {
        panic!("not red")
    };
    assert!(records[0].output_tail.contains("AssertionError"));
    assert!(
        matches!(&records[1].kind, evidence::EvidenceKind::ReproGreen {test_id:id, cases:c, ..} if id == test_id && cases == c)
    );
    assert!(records[0].seq < records[1].seq && records[1].seq < records[2].seq);
    assert_ne!(records[0].tree_hash_before, records[1].tree_hash_before);
    let policy = evidence::Ledger::new(dir.path()).policy;
    assert!(super::super::evidence_tree::repro_snapshot(dir.path(), &policy.base, &["regression.test.js".into()]).unwrap().non_test_changed);
    let state = exported(&mut h).await;
    let tree = evidence_tree::tree_hash(dir.path()).unwrap();
    assert!(!state.evidence.as_ref().unwrap().repro_missing(Some(&tree)));
    let mut restored = Checkpoint::import(serde_json::to_value(&state).unwrap(), "run", "owner")
        .await
        .unwrap();
    restored.evidence.as_mut().unwrap().restore(Some(&tree));
    assert_eq!(
        restored.evidence.as_ref().unwrap().records,
        state.evidence.as_ref().unwrap().records
    );
    assert_eq!(
        restored.evidence.as_ref().unwrap().task,
        state.evidence.as_ref().unwrap().task
    );
}

#[tokio::test]
async fn repro_green_without_non_test_fix_is_not_recorded_even_if_flaky_test_passes() {
    for other_test_change in ["none", "regular", "hardlink", "symlink"] {
        let dir = repro_repository();
        std::fs::write(dir.path().join(".gitignore"), "node_modules\n.flaky-state\n.flaky-cache/\n").unwrap();
        git(dir.path(), &["add", ".gitignore"]);
        git(dir.path(), &["commit", "-qm", "ignore external flaky state"]);
        let flaky = "import {test,expect} from 'vitest'; import {existsSync} from 'node:fs'; test('flaky regression',()=>expect(existsSync('.flaky-state')).toBe(true));\n";
        let seen = Arc::new(Mutex::new(vec![]));
        let url = mock(vec![
            call("declare", "declare_task", json!({"kind":"bug","repro_plan":"flaky test is not a fix"})),
            call("test", "write", json!({"path":"regression.test.js","content":flaky})),
            call("red", "run_checks", json!({"repro":"red","test_files":["regression.test.js"]})),
            call("external", "bash", json!({"command": match other_test_change {
                "regular" => "touch .flaky-state; printf '// unrelated test helper\\n' > other.test.js",
                "hardlink" => "touch .flaky-state; mkdir .flaky-cache; printf '// helper\\n' > other.test.js; ln other.test.js .flaky-cache/link",
                "symlink" => "touch .flaky-state; mkdir .flaky-cache; printf '// helper\\n' > .flaky-cache/helper; ln -s .flaky-cache/helper other.test.js",
                _ => "touch .flaky-state",
            }})),
            call("green", "run_checks", json!({"repro":"green","test_files":["regression.test.js"]})),
            call("unverified", "declare_unverified", json!({"reason":"no non-test fix"})),
            finish(),
        ], seen.clone()).await;
        let mut h = spawn(ApiClient::new(url, None), config(dir.path()));
        let events = turn(&mut h).await;
        assert!(serde_json::to_string(&*seen.lock().unwrap()).unwrap().contains("Green requires a non-test change since red"));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::EvidenceRecorded {record} if matches!(record.kind, evidence::EvidenceKind::ReproRed {..}))));
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::EvidenceRecorded {record} if matches!(record.kind, evidence::EvidenceKind::ReproGreen {..}))), "flaky green admitted: {events:?}");
        let ledger = exported(&mut h).await.evidence.unwrap();
        assert!(ledger.repro_missing(Some(&evidence_tree::tree_hash(dir.path()).unwrap())));
    }
}

#[tokio::test]
async fn repro_bash_production_edit_before_red_is_refused_by_tree_not_tool_path() {
    let dir = repro_repository();
    let script = vec![
        call(
            "declare",
            "declare_task",
            json!({"kind":"bug","repro_plan":"regression"}),
        ),
        call(
            "test",
            "write",
            json!({"path":"regression.test.js","content":REPRO_TEST}),
        ),
        call(
            "bypass",
            "bash",
            json!({"command":"printf 'module.exports = 3;\\n' > source.js"}),
        ),
        call(
            "red",
            "run_checks",
            json!({"repro":"red","test_files":["regression.test.js"]}),
        ),
        call(
            "skip",
            "skip_repro",
            json!({"reason":"cannot_reproduce_locally"}),
        ),
        call(
            "unverified",
            "declare_unverified",
            json!({"reason":"fixture stops after refused red"}),
        ),
        finish(),
    ];
    let seen = Arc::new(Mutex::new(vec![]));
    let url = mock(script, seen.clone()).await;
    let mut h = spawn(ApiClient::new(&url, None), config(dir.path()));
    let events = turn(&mut h).await;
    assert!(!events.iter().any(|e| matches!(e, AgentEvent::EvidenceRecorded { record } if matches!(record.kind, evidence::EvidenceKind::ReproRed {..}))));
    assert!(
        serde_json::to_string(&*seen.lock().unwrap())
            .unwrap()
            .contains("non-test tree differs from pinned base")
    );
    assert_eq!(
        exported(&mut h).await.evidence.unwrap().task.unwrap().skip,
        Some(super::super::repro::SkipReason::CannotReproduceLocally)
    );
}

#[test]
fn repro_separate_grammar_rejects_free_commands_unchanged_files_and_unsupported_runners() {
    let dir = repro_repository();
    std::fs::write(dir.path().join("regression.test.js"), REPRO_TEST).unwrap();
    let policy = evidence::Ledger::new(dir.path()).policy;
    for input in [
        json!({"repro":"red","test_files":["regression.test.js"],"command":"npm test"}),
        json!({"repro":"red","test_files":["regression.test.js;echo secret"]}),
        json!({"repro":"red","test_files":["../regression.test.js"]}),
        json!({"repro":"red","test_files":["source.js"]}),
        json!({"repro":"red","test_files":["regression.test.js"],"run_in_background":true}),
        json!({"repro":"red","test_files":["regression.test.js"],"timeout_ms":999999}),
    ] {
        assert!(
            super::super::repro::prepare(dir.path(), &policy, &input).is_err(),
            "{input}"
        );
    }
    assert!(
        super::super::repro::prepare(
            dir.path(),
            &policy,
            &json!({"repro":"red","test_files":["regression.test.js"]})
        )
        .is_ok()
    );
    let unsupported = repository();
    std::fs::write(unsupported.path().join("regression.test.js"), REPRO_TEST).unwrap();
    let policy = evidence::Ledger::new(unsupported.path()).policy;
    let err = super::super::repro::prepare(
        unsupported.path(),
        &policy,
        &json!({"repro":"red","test_files":["regression.test.js"]}),
    )
    .unwrap_err();
    assert!(err.to_string().contains("skip_repro(no_cheap_test_path)"));
}

#[tokio::test]
async fn repro_all_skip_reasons_are_explicit_and_feature_has_no_repro_gate() {
    let dir = repository();
    let s = shared(dir.path());
    let run = Run {
        id: "main".into(),
        kind: None,
        inherited_mode: None,
    };
    let cancel = CancellationToken::new();
    for reason in [
        "no_cheap_test_path",
        "needs_external_service",
        "ui_only",
        "cannot_reproduce_locally",
    ] {
        s.evidence.lock().unwrap().task = None;
        let turn = Turn {
            run: &run,
            cancel: &cancel,
            started: Instant::now(),
            tool_count: 0,
        };
        let declaration = run_call(
            &s,
            turn,
            "d".into(),
            "declare_task".into(),
            json!({"kind":"bug","repro_plan":"local"}),
        )
        .await;
        assert!(matches!(
            declaration,
            Block::ToolResult {
                is_error: false,
                ..
            }
        ));
        let skipped = run_call(
            &s,
            turn,
            "s".into(),
            "skip_repro".into(),
            json!({"reason":reason}),
        )
        .await;
        assert!(matches!(
            skipped,
            Block::ToolResult {
                is_error: false,
                ..
            }
        ));
        assert!(!s.evidence.lock().unwrap().repro_missing(None));
        let invalid = run_call(
            &s,
            turn,
            "x".into(),
            "skip_repro".into(),
            json!({"reason":"just because"}),
        )
        .await;
        assert!(matches!(invalid, Block::ToolResult { is_error: true, .. }));
    }
    let mut l = s.evidence.lock().unwrap();
    l.task.as_mut().unwrap().kind = super::super::repro::TaskKind::Feature;
    l.task.as_mut().unwrap().skip = None;
    assert!(!l.repro_missing(None));
}

#[tokio::test]
async fn repro_checkpoint_after_red_then_rekey_fix_green_retains_pinned_order() {
    let dir = repro_repository();
    let url = mock(
        vec![
            call(
                "declare",
                "declare_task",
                json!({"kind":"bug","repro_plan":"restart between red and fix"}),
            ),
            call(
                "test",
                "write",
                json!({"path":"regression.test.js","content":REPRO_TEST}),
            ),
            call(
                "red",
                "run_checks",
                json!({"repro":"red","test_files":["regression.test.js"]}),
            ),
            call(
                "pause",
                "declare_unverified",
                json!({"reason":"fixture restart after red"}),
            ),
            finish(),
        ],
        Arc::new(Mutex::new(vec![])),
    )
    .await;
    let mut first = spawn(ApiClient::new(url, None), config(dir.path()));
    turn(&mut first).await;
    let mut state = exported(&mut first).await;
    let tree = evidence_tree::tree_hash(dir.path()).unwrap();
    let ledger = state.evidence.as_mut().unwrap();
    let red = ledger.records[0].clone();
    assert!(matches!(red.kind, evidence::EvidenceKind::ReproRed { .. }));
    // More than a complete ordinary retention window cannot erase the red pin.
    for _ in 0..45 {
        signed_record(ledger, &tree);
    }
    assert_eq!(ledger.records.len(), 40);
    assert!(ledger.records[0] == red);
    ledger.validate().unwrap();
    let url = mock(
        vec![
            call(
                "fix",
                "bash",
                json!({"command":"printf 'module.exports = 2;\\n' > source.js"}),
            ),
            call(
                "green",
                "run_checks",
                json!({"repro":"green","test_files":["regression.test.js"]}),
            ),
            call("normal", "run_checks", json!({"command":"npm test"})),
            finish(),
        ],
        Arc::new(Mutex::new(vec![])),
    )
    .await;
    let mut second = spawn(ApiClient::new(url, None), config(dir.path()));
    initialize(&mut second, "08".repeat(32)).await;
    second
        .input
        .send(AgentInput::ImportState(ImportStateInput {
            request_id: "resume".into(),
            run_id: "run".into(),
            owner_id: "owner".into(),
            state: serde_json::to_value(state).unwrap(),
        }))
        .unwrap();
    let imported = until(&mut second, |e| {
        matches!(
            e,
            AgentEvent::StateImported { .. } | AgentEvent::StateError { .. }
        )
    })
    .await;
    assert!(matches!(
        imported.last(),
        Some(AgentEvent::StateImported { .. })
    ));
    second
        .input
        .send(AgentInput::User {
            text: "Continue after red".into(),
            images: vec![],
        })
        .unwrap();
    until(
        &mut second,
        |e| matches!(e,AgentEvent::TurnEnd {agent_id,..} if agent_id=="main"),
    )
    .await;
    let restored = exported(&mut second).await.evidence.unwrap();
    assert!(restored.records[0] == red);
    assert!(restored.historical_ids.contains(&red.id));
    assert!(
        restored
            .records
            .iter()
            .any(
                |r| matches!(r.kind, evidence::EvidenceKind::ReproGreen { .. }) && r.seq > red.seq
            )
    );
    assert!(!restored.repro_missing(Some(&evidence_tree::tree_hash(dir.path()).unwrap())));
    restored.validate().unwrap();
}

#[tokio::test]
async fn repro_bug_gate_uses_two_fixed_rounds_and_records_missing_repro() {
    let dir = repository();
    let script = vec![
        call(
            "d",
            "declare_task",
            json!({"kind":"bug","repro_plan":"missing"}),
        ),
        finish(),
        finish(),
        finish(),
    ];
    let requests = Arc::new(Mutex::new(vec![]));
    let url = mock(script, requests.clone()).await;
    let mut h = spawn(ApiClient::new(url, None), config(dir.path()));
    turn(&mut h).await;
    let state = exported(&mut h).await;
    assert_eq!(gate_count(&state.history), 2);
    let ledger = state.evidence.unwrap();
    assert_eq!(ledger.turn_gate_rounds, 2);
    assert!(
        ledger
            .unverified
            .iter()
            .any(|s| s == "no failing repro recorded")
    );
    assert_eq!(requests.lock().unwrap().len(), 4);
}

#[test]
fn repro_rust_and_python_share_path_policy_without_widening_test_writer() {
    let root = tempfile::tempdir().unwrap();
    let mut paths = Vec::new();
    for dir in ["", "api/test/", "web/src/", "runner/tests/", "runner/src/", "containers/", "pkg/tests/", "pkg/tests/nested/", "pkg/src/", ".git/", ".gond-agent/", "pkg/.GIT/", "pkg/.git./"] {
        for file in ["a.test.ts", "a.test.tsx", "a.test.js", "a.test.mjs", "a.spec.ts", "a.spec.tsx", "test_a.py", "a_test.go", "helper.rs", "a_tests.rs", "source.js", "config.toml"] {
            paths.push(format!("{dir}{file}"));
        }
    }
    paths.extend(["../a.test.ts", "/a.test.ts", "pkg/../a.test.ts", "pkg//a.test.ts", "pkg/a\n.test.ts"].map(String::from));
    let expected = paths.iter().map(|p| super::super::repro::test_path(root.path(), p)).collect::<Vec<_>>();
    let output = std::process::Command::new("python3")
        .env_clear().env("PATH", "/usr/bin:/bin").env("PYTHONDONTWRITEBYTECODE", "1")
        .args(["-c", "import importlib.util,json,sys; s=importlib.util.spec_from_file_location('agent',sys.argv[1]); a=importlib.util.module_from_spec(s); s.loader.exec_module(a); print(json.dumps([a.repro_test_path(p) for p in json.loads(sys.argv[2])]))"])
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../containers/agent.py"))
        .arg(serde_json::to_string(&paths).unwrap()).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let python: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(expected, python, "Rust/Python repro path policies diverged");
    assert!(super::super::repro::test_path(root.path(), "pkg/tests/helper.rs"));
    assert!(!super::super::subagents::test_path(root.path(), "pkg/tests/helper.rs"));
}

#[test]
fn repro_go_attribution_cannot_borrow_an_unchanged_test_from_another_package() {
    let dir = repository();
    std::fs::write(dir.path().join("go.mod"), "module example.test/tiny\n").unwrap();
    git(dir.path(), &["add", "go.mod"]);
    git(dir.path(), &["commit", "-qm", "go module base"]);
    std::fs::create_dir(dir.path().join("sub")).unwrap();
    std::fs::write(
        dir.path().join("value_test.go"),
        "package tiny\nfunc TestSame(t *testing.T) {}\n",
    )
    .unwrap();
    std::fs::write(
        dir.path().join("sub/new_test.go"),
        "package sub\nfunc TestNew(t *testing.T) {}\n",
    )
    .unwrap();
    let policy = evidence::Ledger::new(dir.path()).policy;
    let prepared = super::super::repro::prepare(
        dir.path(),
        &policy,
        &json!({"repro":"red","test_files":["value_test.go","sub/new_test.go"]}),
    )
    .unwrap();
    let forged = json!({"sources":{"example.test/tiny/sub::TestSame":"value_test.go"}});
    assert!(!super::super::repro::attributed(
        dir.path(),
        &prepared,
        &forged,
        &["example.test/tiny/sub::TestSame".into()]
    ));
    let valid = json!({"sources":{"example.test/tiny::TestSame":"value_test.go"}});
    assert!(super::super::repro::attributed(
        dir.path(),
        &prepared,
        &valid,
        &["example.test/tiny::TestSame".into()]
    ));
}
