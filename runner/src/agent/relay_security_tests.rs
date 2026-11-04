// Runs through task -> scoped test_writer -> run_checks -> bash -> actual shell, with the parent worker
// test process holding the relay token. Subagents share ApiClient, not child credentials.
#[tokio::test]
async fn subagent_shell_children_cannot_inherit_relay_authentication() {
    if !crate::relay_security_tests::seeded("agent::core::tests::subagent_shell_children_cannot_inherit_relay_authentication") { return; }
    use crate::tools::testutil::http::{Res, serve};
    let token = std::env::var(crate::config::RELAY_TOKEN_ENV).unwrap();
    let recorded = Arc::new(StdMutex::new(Vec::new()));
    let seen = recorded.clone();
    let url = serve(move |req| {
        let body = req.json();
        let agent = body["metadata"]["agent_id"].as_str().unwrap_or("");
        let first = body["messages"].as_array().unwrap().len() == 1;
        let reply = match (agent, first) {
            ("main", true) => sse(&[json!({"type":"tool_call","id":"delegate","name":"task","input":{
                "description":"Check child environment","prompt":"Run the child probe","kind":"test_writer"
            }})], "tool_use"),
            ("main", false) => sse(&[json!({"type":"text","text":"Done"})], "end_turn"),
            (_, true) => sse(&[json!({"type":"tool_call","id":"probe","name":"run_checks","input":{
                "command":"python3 -m unittest discover -s containers -p 'test_*.py'"
            }})], "tool_use"),
            (_, false) => sse(&[json!({"type":"text","text":"{\"added\":[],\"results\":[\"Child checked\"]}"})], "end_turn"),
        };
        seen.lock().unwrap().push(req);
        Res::new(200, "text/event-stream", reply)
    }).await;
    let dir = tempfile::tempdir().unwrap();
    // A repository test script exercises the unchanged exec environment scrubbing.
    std::fs::create_dir(dir.path().join("containers")).unwrap();
    std::fs::write(dir.path().join("containers/test_environment.py"), r#"import os
from pathlib import Path
import unittest
class ChildEnvironment(unittest.TestCase):
    def test_relay_not_inherited(self):
        self.assertNotIn("GOND_AGENT_RELAY_TOKEN", os.environ)
        Path("child-probe.txt").write_text("subagent-child-scrubbed")
"#).unwrap();
    let mut cfg = config(dir.path(), Mode::Allow);
    cfg.context_window = 200_000;
    let mut h = spawn(ApiClient::new(url, Some(token.clone())), cfg);
    h.input.send(AgentInput::User { text: "Delegate the probe".into(), images: vec![] }).unwrap();
    let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
    assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolEnd { agent_id, ok: true, .. } if agent_id.starts_with("test_writer-"))));
    assert_eq!(std::fs::read_to_string(dir.path().join("child-probe.txt")).unwrap(), "subagent-child-scrubbed");
    assert!(!format!("{events:?}").contains(&token));
    let requests = recorded.lock().unwrap();
    assert_eq!(requests.len(), 4);
    for req in requests.iter() {
        assert_eq!(req.header("authorization"), Some(format!("bearer {token}")));
        assert!(!String::from_utf8_lossy(&req.body).contains(&token));
    }
    let sub_result = requests.iter().find(|req| {
        let body = req.json();
        body["metadata"]["agent_id"] != "main" && body["messages"].as_array().unwrap().len() > 1
    }).unwrap().json();
    assert!(!sub_result["messages"][2]["content"][0]["is_error"].as_bool().unwrap_or(false));
}
