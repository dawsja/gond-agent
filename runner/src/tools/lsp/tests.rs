//! Protocol tests use a Python peer, not a fake executable in a noexec tempdir.
//! Real-server tests are optional and never install language tools or dependencies.
use super::*;
use tempfile::TempDir;

fn project() -> TempDir {
    // Direct Server fixtures need the same canonical root as the production LSP
    // entry point; otherwise symlinked TMPDIR aliases make valid file URIs look external.
    tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap()
}

pub(super) fn fixture_command(language: Language, log: &Path, mode: &str) -> Command {
    let mut command = Command::new("python3");
    command
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/tools/lsp/fake_server.py"))
        .args(["--mode", mode, "--log"])
        .arg(log);
    // Seed command-scoped hostile overrides, never mutate the test process env.
    for name in [
        crate::config::RELAY_TOKEN_ENV, "GOND_AGENT_TEST_SECRET", "GH_TOKEN",
        "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_OPTIONS",
        "NODE_PATH", "RUSTC_WRAPPER", "RUSTFLAGS", "CARGO_TARGET_DIR",
    ] {
        command.env(name, "must-not-reach-lsp");
    }
    environment(&mut command, language);
    limits(&mut command, language);
    command
}

async fn fake(root: &Path, language: Language, mode: &str) -> Server {
    let command = fixture_command(language, &root.join("rpc.jsonl"), mode);
    let mut server = Server::spawn(root, command).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), server.initialize(language))
        .await.expect("fixture initialization stalled").unwrap();
    server
}

fn call(path: &Path, op: &str, line: u64, character: u64) -> Call {
    let (reply, _) = oneshot::channel();
    Call {
        path: path.into(), op: op.into(), position: json!({"line":line,"character":character}),
        cancel: CancellationToken::new(), deadline: Instant::now() + CALL_TIMEOUT, reply,
    }
}

async fn operation(server: &mut Server, path: &Path, op: &str) -> String {
    tokio::time::timeout(Duration::from_secs(15), server.operation(&call(path, op, 0, 0)))
        .await.expect("language operation stalled").unwrap()
}

async fn state(server: &mut Server) -> Value {
    tokio::time::timeout(Duration::from_secs(3), server.request("test/state", json!({})))
        .await.expect("fixture state request stalled").unwrap()
}

fn transcript(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("rpc.jsonl")).unwrap().lines()
        .map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn actor(root: &Path, mode: &'static str) -> (mpsc::Sender<Call>, CancellationToken, tokio::task::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel(1);
    let stop = CancellationToken::new();
    let task = tokio::spawn(session(root.into(), Language::TypeScript, rx, stop.clone(), SessionConfig {
        idle: Duration::from_secs(600), fake_mode: Some(mode),
    }));
    (tx, stop, task)
}

async fn enqueue(tx: &mpsc::Sender<Call>, path: &Path, op: &str, cancel: CancellationToken, budget: Duration) -> oneshot::Receiver<Reply> {
    let (reply, rx) = oneshot::channel();
    let mut work = call(path, op, 0, 0);
    work.reply = reply;
    work.cancel = cancel;
    work.deadline = Instant::now() + budget;
    tx.send(work).await.expect("actor stopped accepting calls");
    rx
}

async fn reply(rx: oneshot::Receiver<Reply>) -> Reply {
    tokio::time::timeout(Duration::from_secs(5), rx).await
        .expect("actor did not reply").expect("actor dropped reply")
}

async fn actor_operation(tx: &mpsc::Sender<Call>, path: &Path, op: &str) -> String {
    reply(enqueue(tx, path, op, CancellationToken::new(), CALL_TIMEOUT).await).await.unwrap()
}

// Real Python/pipe progress must not depend on Tokio's paused clock or trigger its
// automatic time advancement. Yield to the actor, but use bounded wall-clock waits.
async fn wait_log(root: &Path, predicate: impl Fn(&Value) -> bool) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let text = std::fs::read_to_string(root.join("rpc.jsonl")).unwrap_or_default();
        // A concurrent append can leave a partial final line; retry it next time.
        if let Some(message) = text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).find(&predicate) {
            return message;
        }
        assert!(std::time::Instant::now() < deadline, "fixture did not log expected event");
        tokio::task::yield_now().await;
        std::thread::sleep(Duration::from_millis(2));
    }
}

async fn stopped(task: tokio::task::JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(3), task).await
        .expect("session actor did not exit").expect("session actor panicked");
}

fn fixture_pid(root: &Path) -> u32 {
    transcript(root).iter().find(|m| m["test"] == "started").unwrap()["pid"].as_u64().unwrap() as u32
}

#[test]
fn lsp_requires_execution_permission_including_for_read_operations() {
    use crate::permissions::{Mode, Rule, Verdict, decide};
    let tool = crate::tools::builtin().into_iter().find(|tool| tool.name() == "lsp").unwrap();
    assert_eq!(tool.access(), Access::Exec);
    let rules = [Rule::parse("lsp").unwrap()];
    for path in ["src/main.rs", "src/main.ts"] {
        assert!(matches!(decide(Mode::Plan, tool.access(), "lsp", path, &rules), Verdict::Deny(_)));
        assert_eq!(decide(Mode::Ask, tool.access(), "lsp", path, &[]), Verdict::Ask);
        assert_eq!(decide(Mode::Ask, tool.access(), "lsp", path, &rules), Verdict::Allow);
        assert_eq!(decide(Mode::Allow, tool.access(), "lsp", path, &[]), Verdict::Allow);
    }
}

#[tokio::test]
async fn framing_uses_byte_lengths_and_rejects_untrusted_headers_and_bodies() {
    let value = json!({"jsonrpc":"2.0","id":1,"result":"λ😀"});
    let body = serde_json::to_vec(&value).unwrap();
    let bytes = [format!("content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n", body.len()).into_bytes(), body].concat();
    // Real pipes may split even the header terminator and multibyte UTF-8.
    let (mut writer, mut reader) = tokio::io::duplex(17);
    let task = tokio::spawn(async move {
        for byte in bytes { writer.write_all(&[byte]).await.unwrap(); }
    });
    assert_eq!(read_message(&mut reader).await.unwrap(), value);
    task.await.unwrap();

    let cases = vec![
        b"Content-Type: application/json\r\n\r\n{}".to_vec(),
        b"Content-Length: -1\r\n\r\n".to_vec(),
        b"Content-Length: nope\r\n\r\n".to_vec(),
        b"Content-Length: 2\r\ncontent-length: 2\r\n\r\n{}".to_vec(),
        format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE + 1).into_bytes(),
        b"Content-Length: 184467440737095516160\r\n\r\n".to_vec(),
        b"Content-Length: 5\r\n\r\n{}".to_vec(),
        b"Content-Length: 1\r\n\r\n{".to_vec(),
        b"Content-Length: 1\r\n\r\n\xff".to_vec(),
        b"\xff: 1\r\nContent-Length: 2\r\n\r\n{}".to_vec(),
        vec![b'x'; 8193],
    ];
    for bytes in cases {
        assert!(read_message(&mut bytes.as_slice()).await.is_err(), "accepted malformed frame");
    }
    // A complete frame must not consume any bytes belonging to its successor.
    let bytes = b"Content-Length: 2\r\n\r\n{}Content-Length: 4\r\n\r\nnull";
    let mut input = bytes.as_slice();
    assert_eq!(read_message(&mut input).await.unwrap(), json!({}));
    assert_eq!(read_message(&mut input).await.unwrap(), Value::Null);
}

#[tokio::test]
async fn handshake_environment_is_allowlisted_and_rust_target_is_child_scoped() {
    for language in [Language::TypeScript, Language::Rust] {
        let dir = project();
        let inherited_target = std::env::var_os("CARGO_TARGET_DIR");
        let mut server = fake(dir.path(), language, "push").await;
        let snapshot = state(&mut server).await;
        assert_eq!(snapshot["initialized"], true);
        let init = &snapshot["initialization"];
        assert_eq!(init["rootUri"], file_uri(dir.path()).unwrap());
        assert_eq!(init["workspaceFolders"][0]["uri"], init["rootUri"]);
        assert_eq!(init["capabilities"]["general"]["positionEncodings"], json!(["utf-16"]));
        assert_eq!(init["capabilities"]["workspace"]["applyEdit"], false);
        assert_eq!(init["capabilities"]["textDocument"]["diagnostic"]["dynamicRegistration"], false);
        let keys = snapshot["env_keys"].as_array().unwrap();
        for key in keys {
            let key = key.as_str().unwrap();
            assert!(!key.starts_with("GOND_AGENT_"), "leaked product environment key");
            assert!(![crate::config::RELAY_TOKEN_ENV, "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NODE_PATH", "RUSTFLAGS", "RUSTC_WRAPPER"].contains(&key), "leaked credential or injection key");
        }
        match language {
            Language::Rust => {
                assert_eq!(snapshot["target"], RUST_TARGET_DIR);
                assert!(snapshot["node_options"].is_null());
                assert_eq!(init["initializationOptions"]["cargo"]["targetDir"], RUST_TARGET_DIR);
                assert_eq!(init["initializationOptions"]["cargo"]["extraArgs"], json!(["--locked"]));
            }
            Language::TypeScript => {
                assert!(snapshot["target"].is_null());
                assert_eq!(snapshot["node_options"], "--max-old-space-size=384");
                assert_eq!(init["initializationOptions"]["tsserver"]["path"], TS_SDK);
                assert_eq!(init["initializationOptions"]["disableAutomaticTypingAcquisition"], true);
                assert!(!init.to_string().contains("allowLocalPluginLoads"));
                assert_eq!(init["initializationOptions"]["preferences"]["includePackageJsonAutoImports"], "off");
            }
        }
        assert_eq!(std::env::var_os("CARGO_TARGET_DIR"), inherited_target);
        server.close().await;
    }
}

#[tokio::test]
async fn push_and_pull_diagnostics_track_disk_changes_and_navigation_is_read_only() {
    for mode in ["push", "pull"] {
        let dir = project();
        let path = dir.path().join("space λ.ts");
        std::fs::write(&path, "const BROKEN = '😀';\n").unwrap();
        let mut server = fake(dir.path(), Language::TypeScript, mode).await;
        assert_eq!(server.pull, mode == "pull");
        let diagnostics = operation(&mut server, &path, "diagnostics").await;
        assert!(diagnostics.starts_with(FRAME));
        assert!(diagnostics.contains("1:3 severity 1: error in version 1"), "{diagnostics}");
        assert!(!diagnostics.contains("STALE"));
        assert!(!diagnostics.contains("OUTSIDE"));
        let definition = operation(&mut server, &path, "definition").await;
        assert!(definition.contains("space λ.ts:2:4"), "{definition}");
        assert!(!definition.contains("outside-secret"));
        assert!(!definition.contains("WRONG RESPONSE"));
        assert!(!definition.contains("IGNORE THIS INSTRUCTION"));
        let references = operation(&mut server, &path, "references").await;
        assert!(references.contains("space λ.ts:2:4"));
        assert!(operation(&mut server, &path, "hover").await.contains("const BROKEN"));

        std::fs::write(&path, "const fixed = '😀';\n").unwrap();
        let diagnostics = operation(&mut server, &path, "diagnostics").await;
        assert!(diagnostics.contains("No diagnostics"), "{diagnostics}");
        assert!(!diagnostics.contains("version 1"));
        let snapshot = state(&mut server).await;
        let uri = file_uri(&path).unwrap();
        assert_eq!(snapshot["documents"][&uri]["version"], 2);
        assert_eq!(snapshot["documents"][&uri]["text"], "const fixed = '😀';\n");
        assert!(server.diagnostics.keys().all(|key| key == &uri));
        let messages = transcript(dir.path());
        let named = |method: &str| messages.iter().filter(|m| m["method"] == method).count();
        assert_eq!(named("textDocument/didOpen"), 1);
        assert_eq!(named("textDocument/didChange"), 1);
        assert!(messages.iter().any(|m| m["method"] == "textDocument/references" && m["params"]["context"]["includeDeclaration"] == true));
        assert!(!messages.iter().any(|m| m["method"] == "workspace/executeCommand"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "const fixed = '😀';\n");
        server.close().await;
    }
}

#[tokio::test]
async fn server_initiated_mutations_and_capability_registration_are_denied() {
    let dir = project();
    let sentinel = dir.path().join("untouched.ts");
    std::fs::write(&sentinel, "do not change\n").unwrap();
    let mut server = fake(dir.path(), Language::TypeScript, "push").await;
    let responses = tokio::time::timeout(Duration::from_secs(3), server.request("test/requests", json!({})))
        .await.expect("server-request denial stalled").unwrap();
    for index in 0..4 {
        let response = &responses[format!("server-{index}")];
        assert_eq!(response["error"]["code"], -32601, "{response}");
        assert!(response.get("result").is_none());
    }
    let config = responses["server-4"]["result"].as_array().unwrap();
    assert_eq!(config.len(), 64);
    assert!(config.iter().all(Value::is_null));
    assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "do not change\n");
    assert!(!dir.path().join("SHOULD_NOT_EXIST").exists());
    server.close().await;
}

#[tokio::test]
async fn document_cache_closes_lru_and_rejects_large_or_non_utf8_files() {
    let dir = project();
    let mut server = fake(dir.path(), Language::TypeScript, "pull").await;
    let first = dir.path().join("0.ts");
    for index in 0..MAX_DOCS {
        let path = dir.path().join(format!("{index}.ts"));
        std::fs::write(&path, "export const value = 1;\n").unwrap();
        server.sync(&path).await.unwrap();
    }
    // Touching the oldest document makes the second document the eviction victim.
    server.sync(&first).await.unwrap();
    let extra = dir.path().join("extra.ts");
    std::fs::write(&extra, "export {};\n").unwrap();
    server.sync(&extra).await.unwrap();
    let snapshot = state(&mut server).await;
    assert_eq!(snapshot["documents"].as_object().unwrap().len(), MAX_DOCS);
    assert!(snapshot["documents"].get(file_uri(&first).unwrap()).is_some());
    assert!(snapshot["documents"].get(file_uri(&dir.path().join("1.ts")).unwrap()).is_none());
    assert!(transcript(dir.path()).iter().any(|m| m["method"] == "textDocument/didClose" && m["params"]["textDocument"]["uri"] == file_uri(&dir.path().join("1.ts")).unwrap()));
    let huge = dir.path().join("huge.ts");
    std::fs::write(&huge, vec![b'x'; MAX_FILE as usize + 1]).unwrap();
    assert!(server.sync(&huge).await.unwrap_err().contains("1 MiB"));
    let binary = dir.path().join("binary.ts");
    std::fs::write(&binary, [0xff, 0xfe]).unwrap();
    assert!(server.sync(&binary).await.unwrap_err().contains("UTF-8"));
    assert_eq!(server.docs.len(), MAX_DOCS);
    server.close().await;
}

#[tokio::test]
async fn actor_cancellation_sends_cancel_before_shutdown_and_exits() {
    let dir = project();
    let path = dir.path().join("main.ts");
    std::fs::write(&path, "const BROKEN = 1;\n").unwrap();
    let (tx, stop, task) = actor(dir.path(), "hang-hover");
    assert!(actor_operation(&tx, &path, "diagnostics").await.contains("error in version 1"));
    let pid = fixture_pid(dir.path());
    let token = CancellationToken::new();
    let rx = enqueue(&tx, &path, "hover", token.clone(), CALL_TIMEOUT).await;
    let hover = wait_log(dir.path(), |m| m["method"] == "textDocument/hover").await;
    token.cancel();
    assert_eq!(reply(rx).await.unwrap_err(), "interrupted");
    stopped(task).await;
    assert!(tx.is_closed());
    assert!(!stop.is_cancelled(), "call cancellation must not require registry stop");
    let messages = transcript(dir.path());
    let cancellation = messages.iter().position(|m| m["method"] == "$/cancelRequest" && m["params"]["id"] == hover["id"]).expect("missing cancellation");
    let shutdown = messages.iter().position(|m| m["method"] == "shutdown").expect("missing shutdown");
    assert!(cancellation < shutdown);
    #[cfg(unix)]
    wait_dead(pid).await;
    #[cfg(not(unix))]
    let _ = pid;
}

#[tokio::test]
async fn actor_timeout_preserves_healthy_server_but_crash_and_oversize_restart() {
    for mode in ["hang-hover", "crash-hover", "oversize-hover"] {
        let dir = project();
        let path = dir.path().join("main.ts");
        std::fs::write(&path, "const BROKEN = 1;\n").unwrap();
        let (tx, stop, task) = actor(dir.path(), mode);
        // Warm up with a real handshake before imposing the short actor deadline.
        assert!(actor_operation(&tx, &path, "diagnostics").await.contains("error in version 1"));
        let budget = if mode == "hang-hover" { Duration::from_millis(80) } else { Duration::from_secs(3) };
        let error = reply(enqueue(&tx, &path, "hover", CancellationToken::new(), budget).await).await.unwrap_err();
        assert!(!error.contains("outside-secret"), "{error}");
        assert!(!error.contains("private server failure"), "{error}");
        if mode == "hang-hover" { assert!(error.contains("timed out"), "{error}"); }
        if mode == "oversize-hover" { assert!(error.contains("limit"), "{error}"); }
        assert!(!task.is_finished(), "actor exited instead of remaining available after {mode}");
        // This is the SAME actor/channel, not a manually constructed replacement.
        assert!(actor_operation(&tx, &path, "diagnostics").await.contains("error in version 1"));
        let messages = transcript(dir.path());
        let starts = if mode == "hang-hover" { 1 } else { 2 };
        assert_eq!(messages.iter().filter(|m| m["method"] == "initialize").count(), starts, "{mode}");
        assert_eq!(messages.iter().filter(|m| m["method"] == "initialized").count(), starts, "{mode}");
        assert_eq!(messages.iter().filter(|m| m["method"] == "textDocument/didOpen").count(), starts, "{mode}");
        if mode == "hang-hover" {
            let hover = messages.iter().find(|m| m["method"] == "textDocument/hover").unwrap();
            assert!(messages.iter().any(|m| m["method"] == "$/cancelRequest" && m["params"]["id"] == hover["id"]));
        }
        stop.cancel();
        stopped(task).await;
        #[cfg(unix)]
        for message in messages.iter().filter(|m| m["test"] == "started") {
            wait_dead(message["pid"].as_u64().unwrap() as u32).await;
        }
    }

    let dir = project();
    let mut server = fake(dir.path(), Language::TypeScript, "push").await;
    let error = server.request("test/error", json!({})).await.unwrap_err();
    assert!(!error.contains("outside-secret"));
    assert!(!error.contains("private path"));
    server.close().await;
}

#[tokio::test]
async fn slow_initialization_survives_call_deadline_and_second_call_reuses_server() {
    let dir = project();
    let path = dir.path().join("main.rs");
    std::fs::write(&path, "fn main() {}\n").unwrap();
    let (tx, rx) = mpsc::channel(1);
    let stop = CancellationToken::new();
    let task = tokio::spawn(session(dir.path().into(), Language::Rust, rx, stop.clone(), SessionConfig {
        idle: IDLE, fake_mode: Some("slow-initialize"),
    }));
    std::fs::write(dir.path().join("Cargo.toml"), "[package]\nname = \"slow\"\nversion = \"0.1.0\"\n").unwrap();
    let tool = Arc::new(Lsp::default());
    tool.registry.lock().unwrap().sessions.insert((dir.path().canonicalize().unwrap(), Language::Rust), tx.clone());
    let (ctx, _events) = crate::tools::testutil::ctx(dir.path());
    let first = tokio::spawn({
        let tool = tool.clone();
        async move { tool.call(&ctx, &json!({"op":"hover","path":"main.rs","line":1,"column":1})).await }
    });
    wait_log(dir.path(), |m| m["method"] == "initialize").await;
    let pid = fixture_pid(dir.path());
    // Advance beyond the real call budget while the peer is blocked on a marker,
    // avoiding a 20s wall-clock sleep or a race with process startup.
    tokio::time::pause();
    tokio::time::advance(CALL_TIMEOUT + Duration::from_secs(1)).await;
    tokio::time::resume();
    assert!(first.await.unwrap().unwrap_err().contains("timed out"));
    assert!(!tx.is_closed(), "a public call timeout must not cancel cold startup");
    let second = enqueue(&tx, &path, "hover", CancellationToken::new(), CALL_TIMEOUT).await;
    std::fs::write(dir.path().join("initialize-ready"), "now").unwrap();
    assert!(reply(second).await.unwrap().contains("fixture hover"));
    let messages = transcript(dir.path());
    assert_eq!(messages.iter().filter(|m| m["test"] == "started").count(), 1);
    assert_eq!(messages.iter().filter(|m| m["method"] == "initialize").count(), 1);
    assert_eq!(messages.iter().filter(|m| m["method"] == "initialized").count(), 1);
    stop.cancel();
    stopped(task).await;
    #[cfg(unix)]
    wait_dead(pid).await;
    #[cfg(not(unix))]
    let _ = pid;
}

#[tokio::test]
async fn indexing_content_modified_retries_without_restarting_the_server() {
    let dir = project();
    let path = dir.path().join("main.ts");
    std::fs::write(&path, "export const value = 1;\n").unwrap();
    let (tx, stop, task) = actor(dir.path(), "modified-once");
    assert!(actor_operation(&tx, &path, "hover").await.contains("fixture hover"));
    let messages = transcript(dir.path());
    assert_eq!(messages.iter().filter(|m| m["method"] == "initialize").count(), 1);
    let requests: Vec<_> = messages.iter().filter(|m| m["method"] == "textDocument/hover").collect();
    assert_eq!(requests.len(), 2);
    assert_ne!(requests[0]["id"], requests[1]["id"]);
    stop.cancel();
    stopped(task).await;
}

#[tokio::test]
async fn actor_explicit_stop_while_idle_exits_and_reaps_the_child() {
    let dir = project();
    let path = dir.path().join("main.ts");
    std::fs::write(&path, "const value = 1;\n").unwrap();
    let (tx, stop, task) = actor(dir.path(), "push");
    assert!(actor_operation(&tx, &path, "hover").await.contains("fixture hover"));
    let pid = fixture_pid(dir.path());
    stop.cancel();
    stopped(task).await;
    assert!(tx.is_closed());
    assert!(transcript(dir.path()).iter().any(|m| m["method"] == "shutdown"));
    #[cfg(unix)]
    wait_dead(pid).await;
    #[cfg(not(unix))]
    let _ = pid;
}

#[tokio::test]
async fn actor_idle_deadline_is_not_extended_by_server_notifications() {
    let dir = project();
    let path = dir.path().join("main.ts");
    std::fs::write(&path, "const value = 1;\n").unwrap();
    let (tx, _stop, task) = actor(dir.path(), "idle-notifications");
    assert!(actor_operation(&tx, &path, "hover").await.contains("fixture hover"));
    let pid = fixture_pid(dir.path());
    // Only virtualize time AFTER the real subprocess has finished its first call.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(350)).await;
    std::fs::write(dir.path().join("notify"), "now").unwrap();
    wait_log(dir.path(), |m| m["id"] == "idle-notification" && m.get("result").is_some()).await;
    tokio::time::advance(Duration::from_secs(251)).await;
    tokio::time::resume();
    // A reset-on-notification timer would still have 349 seconds left here.
    stopped(task).await;
    assert!(tx.is_closed());
    assert!(transcript(dir.path()).iter().any(|m| m["method"] == "shutdown"));
    #[cfg(unix)]
    wait_dead(pid).await;
    #[cfg(not(unix))]
    let _ = pid;
}

#[tokio::test]
async fn actor_quiet_server_reports_no_diagnostics_yet_after_bounded_wait() {
    let dir = project();
    let path = dir.path().join("main.ts");
    std::fs::write(&path, "const value = 1;\n").unwrap();
    let (tx, stop, task) = actor(dir.path(), "quiet");
    assert!(actor_operation(&tx, &path, "hover").await.contains("fixture hover"));
    let pid = fixture_pid(dir.path());
    let diagnostic_path = dir.path().join("quiet.ts");
    std::fs::write(&diagnostic_path, "export {};\n").unwrap();
    let rx = enqueue(&tx, &diagnostic_path, "diagnostics", CancellationToken::new(), CALL_TIMEOUT).await;
    let uri = file_uri(&diagnostic_path).unwrap();
    wait_log(dir.path(), |m| m["method"] == "textDocument/didOpen" && m["params"]["textDocument"]["uri"] == uri).await;
    let barrier = format!("quiet-open:{uri}");
    wait_log(dir.path(), |m| m["id"] == barrier && m.get("result").is_some()).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(10)).await;
    tokio::time::resume();
    let output = reply(rx).await.unwrap();
    assert!(output.starts_with(FRAME));
    assert!(output.contains("No diagnostics yet"), "{output}");
    assert!(output.contains("10 seconds"), "{output}");
    stop.cancel();
    stopped(task).await;
    #[cfg(unix)]
    wait_dead(pid).await;
    #[cfg(not(unix))]
    let _ = pid;
}

#[cfg(unix)]
async fn wait_dead(pid: u32) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            // A killed grandchild may briefly be a zombie until the host init reaps it.
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"));
            let zombie = stat.as_ref().is_ok_and(|s| s.rsplit_once(") ").is_some_and(|(_, rest)| rest.starts_with('Z')));
            // SAFETY: signal 0 only probes existence; it never signals another process.
            let gone = unsafe { libc::kill(pid as libc::pid_t, 0) } != 0;
            if gone || zombie { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("language server process survived cleanup");
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_server_kills_its_process_group_including_descendants() {
    let dir = project();
    let mut server = fake(dir.path(), Language::TypeScript, "push").await;
    let parent = server.child.id().unwrap();
    let descendant = server.request("test/descendant", json!({})).await.unwrap().as_u64().unwrap() as u32;
    drop(server);
    wait_dead(parent).await;
    wait_dead(descendant).await;
}

#[tokio::test]
async fn invalid_operations_positions_and_outside_paths_never_start_a_session() {
    let dir = project();
    std::fs::write(dir.path().join("main.ts"), "export {};\n").unwrap();
    std::fs::write(dir.path().join("main.rs"), "fn main() {}\n").unwrap();
    std::fs::write(dir.path().join("notes.txt"), "not supported\n").unwrap();
    let (ctx, _events) = crate::tools::testutil::ctx(dir.path());
    let tool = Lsp::default();
    for input in [
        json!({"op":"workspace/executeCommand","path":"main.ts"}),
        json!({"op":"hover","path":"main.ts","line":0,"column":1}),
        json!({"op":"hover","path":"main.ts","line":1,"column":0}),
        json!({"op":"hover","path":"main.ts","line":1,"column":4294967296u64}),
        json!({"op":"definition","path":"main.ts","line":1}),
        json!({"op":"diagnostics","path":"notes.txt"}),
        json!({"op":"diagnostics","path":"main.rs"}),
        json!({"op":"diagnostics","path":dir.path().join("main.ts")}),
        json!({"op":"diagnostics","path":"missing.ts"}),
        json!({"op":"diagnostics","path":"."}),
    ] {
        assert!(tool.call(&ctx, &input).await.is_err(), "accepted {input}");
        assert!(tool.registry.lock().unwrap().sessions.is_empty());
    }
    #[cfg(unix)] {
        let outside = project();
        std::fs::write(outside.path().join("secret.ts"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.ts"), dir.path().join("escape.ts")).unwrap();
        assert!(tool.call(&ctx, &json!({"op":"diagnostics","path":"escape.ts"})).await.unwrap_err().contains("repository"));
        assert!(tool.registry.lock().unwrap().sessions.is_empty());
    }
}

#[test]
fn locations_and_output_are_confined_bounded_and_marked_untrusted() {
    let dir = project();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("src")).unwrap();
    let path = root.join("src/source.ts");
    std::fs::write(&path, "export {};\n").unwrap();
    let outside = project();
    let secret = outside.path().join("secret.ts");
    std::fs::write(&secret, "secret").unwrap();
    assert!(relative_uri(&root, &file_uri(&secret).unwrap()).is_none());
    assert!(relative_uri(&root, "file://remote-host/etc/passwd").is_none());
    assert!(relative_uri(&root, "https://example.invalid/source.ts").is_none());
    assert!(relative_uri(&root, "file:///does-not-exist.ts").is_none());
    #[cfg(unix)] {
        let link = root.join("link.ts");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(relative_uri(&root, &file_uri(&link).unwrap()).is_none());
    }
    let locations = Value::Array((0..MAX_ITEMS + 1).map(|_| json!({
        "uri":file_uri(&path).unwrap(),"range":{"start":{"line":2,"character":4}}
    })).collect());
    let (rows, more) = location_rows(&root, &locations);
    assert_eq!(rows.len(), MAX_ITEMS);
    assert_eq!(rows[0], "src/source.ts:3:5");
    assert!(more);
    assert!(render(&root, rows, more, "empty").contains("src/source.ts:3:5"), "repo-relative navigation paths must survive redaction");
    let diagnostics = json!([{"range":{"start":{"line":0,"character":0}},"severity":2,"message":"λ".repeat(2100)}]);
    let (rows, more) = diagnostic_rows(&root, &diagnostics);
    assert!(more);
    assert_eq!(rows[0].chars().filter(|c| *c == 'λ').count(), 2000);
    let output = render(&root, vec![format!("{} /private/secret.ts file:///private/secret.ts\u{1b}\u{0} {}", root.display(), "😀".repeat(10_000))], false, "empty");
    assert!(output.starts_with(FRAME));
    assert!(output.contains("[truncated: narrow the query]"));
    assert!(!output.contains("/private/"));
    assert!(!output.contains(root.to_str().unwrap()));
    assert!(!output.contains('\u{1b}'));
    assert!(!output.contains('\u{0}'));
    assert!(output.len() < 30_000);
    let mut hover = Vec::new();
    hover_text(&json!(["plain", {"language":"typescript","value":"const value: number"}, {"kind":"markdown","value":"**untrusted**"}]), &mut hover);
    assert_eq!(hover, vec!["plain", "const value: number", "**untrusted**"]);
}

#[test]
fn output_strips_unicode_format_controls_and_the_entire_tag_block() {
    let controls = "\u{ad}\u{61c}\u{180e}\u{200b}\u{200c}\u{200d}\u{200e}\u{200f}\u{202a}\u{202b}\u{202c}\u{202d}\u{202e}\u{2060}\u{2066}\u{2067}\u{2068}\u{2069}\u{feff}\u{110bd}\u{1d173}";
    let tags: String = (0xE0000..=0xE007F).map(|n| char::from_u32(n).unwrap()).collect();
    let output = render(Path::new("/repo"), vec![format!("λ😀\tvisible\n{controls}{tags}\u{0}\u{1b}kept")], false, "empty");
    assert_eq!(output, format!("{FRAME}\nλ😀\tvisible\nkept"));
    let output = render(Path::new("/repo"), vec!["path: \u{200b}/private/secret.ts".into()], false, "empty");
    assert_eq!(output, format!("{FRAME}\npath: [path]"));
}

#[test]
fn output_strips_variation_selectors_in_both_unicode_ranges() {
    let selectors: String = (0xFE00..=0xFE0F).chain(0xE0100..=0xE01EF)
        .map(|n| char::from_u32(n).unwrap()).collect();
    let output = render(Path::new("/repo"), vec![format!("λ😀\tvisible\n{selectors}e\u{301}kept")], false, "empty");
    // Preserve visible text, whitespace and ordinary combining marks, not hidden selectors.
    assert_eq!(output, format!("{FRAME}\nλ😀\tvisible\ne\u{301}kept"));
    let output = render(Path::new("/repo"), vec!["path: /pri\u{fe00}vate/\u{e01ef}secret.ts".into()], false, "empty");
    assert_eq!(output, format!("{FRAME}\npath: [path]"));
}

#[test]
fn output_caps_each_row_before_joining_and_path_redaction() {
    let mut rows = Vec::new();
    hover_text(&json!([
        format!("{} HOVER_TAIL", "λ".repeat(100_000)),
        {"kind":"markdown","value":format!("/{} PATH_TAIL", "x".repeat(100_000))},
        "later row"
    ]), &mut rows);
    let output = render(Path::new("/repo"), rows, false, "empty");
    let lines: Vec<_> = output.lines().collect();
    assert_eq!(lines[0], FRAME);
    assert_eq!(lines[1], "λ".repeat(2000));
    assert_eq!(lines[2], "[path]");
    assert_eq!(lines[3], "later row");
    assert_eq!(lines[4], "[truncated: narrow the query]");
    // Redacting the huge path before capping would expose PATH_TAIL.
    assert!(!output.contains("TAIL"));
    let exact = render(Path::new("/repo"), vec!["😀".repeat(2000)], false, "empty");
    assert!(!exact.contains("[truncated"));
}

#[test]
fn diagnostic_output_formats_only_numeric_severity() {
    let invalid = [json!({"injected":"x".repeat(100_000)}), json!([1, 2]), json!("1"), json!(true), Value::Null, json!(-1), json!(1.5)];
    for (severity, expected) in invalid.into_iter().map(|severity| (severity, 0)).chain([(json!(2), 2)]) {
        let (rows, more) = diagnostic_rows(Path::new("/repo"), &json!([{"severity":severity,"message":"message"}]));
        assert_eq!(rows, vec![format!("1:1 severity {expected}: message")]);
        assert!(!more);
    }
}

// Language servers may answer before initial indexing finishes. Retry only the
// read-only operation, under one deadline, rather than sleeping a fixed startup delay.
async fn indexed_operation(server: &mut Server, request: &Call, expected: &str) -> String {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let result = server.operation(request).await;
            if result.is_err() {
                let tail: Vec<u8> = server._stderr_tail.lock().unwrap().iter().copied().collect();
                eprintln!("fixture server stderr: {}", String::from_utf8_lossy(&tail));
            }
            let output = result.unwrap();
            if output.contains(expected) { return output; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.expect("real language server did not finish indexing")
}

// Real integration fixtures have an unborn Git HEAD: stage a baseline, then compare
// status, index tree and working diff. This detects writes without creating commits.
async fn git(root: &Path, args: &[&str]) -> Vec<u8> {
    let mut command = Command::new("git");
    command.env_clear().env("PATH", std::env::var_os("PATH").unwrap_or_default());
    command.args(["-c", "core.hooksPath=/dev/null"]).args(args).current_dir(root).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), command.output()).await.expect("git stalled").unwrap();
    assert!(output.status.success(), "fixture git command failed");
    output.stdout
}

async fn git_snapshot(root: &Path) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        git(root, &["status", "--porcelain=v1", "--untracked-files=all"]).await,
        git(root, &["write-tree"]).await,
        git(root, &["diff", "--binary"]).await,
    )
}

async fn stage_fixture(root: &Path) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    git(root, &["init", "--quiet"]).await;
    git(root, &["add", "."]).await;
    git_snapshot(root).await
}

#[tokio::test]
async fn real_typescript_diagnostics_navigation_and_disk_resync_preserve_git_baseline() {
    let packaged = Path::new(TS_SERVER).is_file() && Path::new(TS_SDK).is_file();
    let modules = Path::new(env!("CARGO_MANIFEST_DIR")).join("../containers/lsp/node_modules");
    let script = if packaged { PathBuf::from(TS_SERVER) } else { modules.join("typescript-language-server/lib/cli.mjs") };
    let sdk = if packaged { PathBuf::from(TS_SDK) } else { modules.join("typescript/lib/tsserver.js") };
    if !script.is_file() || !sdk.is_file() {
        eprintln!("SKIP real TypeScript LSP: packaged /opt or local containers/lsp/node_modules packages unavailable");
        return;
    }
    let dir = project();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("tsconfig.json"), r#"{"compilerOptions":{"strict":true,"noEmit":true,"target":"ES2022","module":"commonjs","plugins":[{"name":"hostile-local-plugin"}]},"include":["*.ts"]}"#).unwrap();
    let plugin = root.join("node_modules/hostile-local-plugin");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("package.json"), r#"{"name":"hostile-local-plugin","version":"1.0.0","main":"index.js"}"#).unwrap();
    std::fs::write(plugin.join("index.js"), "require('node:fs').writeFileSync(require('node:path').join(__dirname, '../../PLUGIN_LOADED'), 'unsafe'); module.exports = () => ({create: info => info.languageService});").unwrap();
    std::fs::write(root.join("library.ts"), "export function double(value: number): number { return value * 2; }\n").unwrap();
    let source = "import { double } from './library';\nconst result: number = double('wrong');\nconsole.log(result);\n";
    let path = root.join("main.ts");
    std::fs::write(&path, source).unwrap();
    let before = stage_fixture(&root).await;
    let mut command = Command::new("node");
    command.arg(script).arg("--stdio");
    environment(&mut command, Language::TypeScript);
    limits(&mut command, Language::TypeScript);
    let mut server = Server::spawn(&root, command).await.unwrap();
    // Exercise the production handshake with the same pinned SDK outside /opt in development.
    tokio::time::timeout(CALL_TIMEOUT, server.initialize_sdk(Language::TypeScript, &sdk)).await.unwrap().unwrap();
    for (op, line, character, expected) in [
        ("diagnostics", 0, 0, "not assignable"),
        ("definition", 1, 24, "library.ts:1:"),
        ("hover", 1, 24, "number"),
        ("references", 1, 24, "main.ts:"),
    ] {
        let output = indexed_operation(&mut server, &call(&path, op, line, character), expected).await;
        eprintln!("REAL TypeScript LSP {op}:\n{output}");
    }
    assert!(!root.join("PLUGIN_LOADED").exists(), "repository-local TypeScript plugin executed");
    assert_eq!(git_snapshot(&root).await, before, "read-only operations changed fixture Git state");

    // The only intended mutation is this test's disk edit. Re-stage before querying.
    std::fs::write(&path, source.replace("'wrong'", "21")).unwrap();
    let edited = stage_fixture(&root).await;
    let diagnostics = operation(&mut server, &path, "diagnostics").await;
    assert!(diagnostics.contains("No diagnostics"), "{diagnostics}");
    eprintln!("REAL TypeScript LSP diagnostics after disk edit:\n{diagnostics}");
    assert_eq!(server.docs.iter().find(|doc| doc.uri == file_uri(&path).unwrap()).unwrap().version, 2);
    server.close().await;
    drop(server);
    assert_eq!(git_snapshot(&root).await, edited, "resync/shutdown changed fixture Git state");
}

#[tokio::test]
async fn real_rust_navigation_and_diagnostics_preserve_git_baseline_when_available() {
    // Probe only: never invoke Server::start's automatic rustup component install.
    let mut probe = Command::new("rust-analyzer");
    probe.arg("--version").kill_on_drop(true);
    environment(&mut probe, Language::Rust);
    let available = tokio::time::timeout(Duration::from_secs(3), probe.output()).await;
    if !matches!(available, Ok(Ok(ref output)) if output.status.success()) {
        eprintln!("SKIP real Rust LSP: rust-analyzer unavailable (no installation attempted)");
        return;
    }
    if !Path::new(RUST_TARGET_DIR).parent().is_some_and(Path::is_dir) {
        eprintln!("SKIP real Rust LSP: external /opt/gond-tools target volume unavailable");
        return;
    }
    let dir = project();
    let root = dir.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("src")).unwrap();
    std::fs::write(root.join("Cargo.toml"), "[package]\nname = \"lsp_fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n").unwrap();
    std::fs::write(root.join("Cargo.lock"), "version = 4\n\n[[package]]\nname = \"lsp_fixture\"\nversion = \"0.1.0\"\n").unwrap();
    // Build output proves this is Cargo-backed analysis, not loose-file inference.
    let marker = format!("lsp-fixture-built-{}", root.file_name().unwrap().to_string_lossy());
    std::fs::write(root.join("build.rs"), format!("fn main() {{ std::fs::write(std::path::Path::new(&std::env::var_os(\"OUT_DIR\").unwrap()).join({marker:?}), \"checked\").unwrap(); }}\n")).unwrap();
    let path = root.join("src/main.rs");
    std::fs::write(&path, "fn double(value: i32) -> i32 { value * 2 }\nfn main() { let _result: bool = double(21); }\n").unwrap();
    let before = stage_fixture(&root).await;
    let mut command = Command::new("rust-analyzer");
    environment(&mut command, Language::Rust);
    limits(&mut command, Language::Rust);
    let mut server = Server::spawn(&root, command).await.unwrap();
    tokio::time::timeout(CALL_TIMEOUT, server.initialize(Language::Rust)).await.unwrap().unwrap();
    for (op, expected) in [
        ("definition", "src/main.rs:1:"),
        ("hover", "i32"),
        ("references", "src/main.rs:"),
    ] {
        let output = indexed_operation(&mut server, &call(&path, op, 1, 32), expected).await;
        eprintln!("REAL Rust LSP {op}:\n{output}");
    }
    let diagnostics = indexed_operation(&mut server, &call(&path, "diagnostics", 0, 0), "severity 1").await;
    assert!(diagnostics.contains("mismatch") || diagnostics.contains("expected"), "{diagnostics}");
    eprintln!("REAL Rust LSP diagnostics:\n{diagnostics}");
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if ignore::WalkBuilder::new(RUST_TARGET_DIR).hidden(false).git_ignore(false).build()
                .filter_map(Result::ok).any(|entry| entry.file_name() == marker.as_str()) { break; }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await.expect("Rust LSP did not execute Cargo build scripts into the external target directory");
    eprintln!("REAL Rust LSP Cargo build output found under RUST_TARGET_DIR; checkout unchanged");
    server.close().await;
    drop(server);
    assert_eq!(git_snapshot(&root).await, before, "Rust LSP dirtied fixture checkout");
    assert!(!root.join("target").exists());
}
