use std::io::Write;

use anyhow::Result;
use tokio::io::AsyncBufReadExt;

use crate::agent::AgentHandle;
use crate::agent::events::{AgentEvent, AgentInput};

// Never include checkpoint contents (or serde errors containing field names) in logs.
fn decode_input(line: &str) -> std::result::Result<AgentInput, Option<Box<AgentEvent>>> {
    let value: serde_json::Value = serde_json::from_str(line).map_err(|_| None)?;
    let correlation = value["type"].as_str().filter(|op| matches!(*op, "export_state" | "import_state" | "checkpoint.release"))
        .zip(value["request_id"].as_str().filter(|id| id.len() <= 256))
        .map(|(op, id)| (op.to_owned(), id.to_owned()));
    serde_json::from_value(value).map_err(|_| correlation.map(|(operation, request_id)| {
        Box::new(AgentEvent::StateError { request_id, operation, code: "invalid_command".into() })
    }))
}

enum Control {
    Pending,
    Frame(Box<AgentEvent>),
}

/// JSONL protocol: AgentInput lines on stdin, AgentEvent lines on stdout. Exits when stdin closes
/// and the current turn has finished.
pub async fn jsonl(mut agent: AgentHandle) -> Result<i32> {
    let input = agent.input.clone();
    let (control_tx, mut control_rx) = tokio::sync::mpsc::unbounded_channel();
    let (eof_tx, mut eof_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            match decode_input(&line) {
                Ok(i) => {
                    if matches!(i, AgentInput::ExportState(_) | AgentInput::ImportState(_) | AgentInput::CheckpointRelease(_)) {
                        let _ = control_tx.send(Control::Pending);
                    }
                    let _ = input.send(i);
                }
                Err(Some(event)) => { let _ = control_tx.send(Control::Frame(event)); }
                Err(None) => eprintln!("gond-agent: ignoring invalid input"),
            }
        }
        let _ = eof_tx.send(());
    });

    let mut out = std::io::stdout();
    let mut busy = 0i32;
    let mut pending_controls = 0i32;
    let mut stdin_closed = false;
    loop {
        tokio::select! {
            Some(control) = control_rx.recv() => match control {
                Control::Pending => pending_controls += 1,
                Control::Frame(event) => {
                    writeln!(out, "{}", serde_json::to_string(&event)?)?;
                    out.flush()?;
                }
            },
            ev = agent.events.recv() => {
                let Some(ev) = ev else { break };
                match &ev {
                    AgentEvent::TurnStart { agent_id } if agent_id == "main" => busy += 1,
                    AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main" => busy -= 1,
                    AgentEvent::StateExported { .. } | AgentEvent::StateImported { .. } | AgentEvent::StateError { .. } | AgentEvent::CheckpointReleased { .. } => pending_controls -= 1,
                    _ => {}
                }
                writeln!(out, "{}", serde_json::to_string(&ev)?)?;
                out.flush()?;
            }
            _ = &mut eof_rx, if !stdin_closed => {
                stdin_closed = true;
                // Give a just-sent user message a moment to start its turn.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        if stdin_closed && busy <= 0 && pending_controls <= 0 && agent.events.is_empty() && control_rx.is_empty() { break; }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::{Decision, ExportStateInput, ImageInput, ImportStateInput};
    use crate::permissions::Mode;

    #[test]
    fn api_and_controller_frames_decode_without_losing_user_messages() {
        // Wire shapes from runs/service.ts rpc("send"), controller state_rpc,
        // and the remaining existing AgentInput controls forwarded by send.
        let image = ImageInput { media_type: "image/png".into(), data: "aW1hZ2U=".into(), id: None };
        let frames = [
            (r#"{"type":"user","text":"Continue","effort":"high","images":[{"media_type":"image/png","data":"aW1hZ2U="}]}"#,
                AgentInput::User { text: "Continue".into(), images: vec![image.clone()] }),
            (r#"{"type":"user","text":"","effort":"high","images":[{"media_type":"image/png","data":"aW1hZ2U="}]}"#,
                AgentInput::User { text: String::new(), images: vec![image.clone()] }),
            (r#"{"type":"user","images":[{"media_type":"image/png","data":"aW1hZ2U="}]}"#,
                AgentInput::User { text: String::new(), images: vec![image] }),
            (r#"{"type":"model","model":"connection/model","context_window":100000}"#,
                AgentInput::Model { model: "connection/model".into(), context_window: 100000 }),
            (r#"{"type":"effort","effort":"high"}"#, AgentInput::Effort { effort: "high".into() }),
            (r#"{"type":"compact"}"#, AgentInput::Compact),
            (r#"{"type":"question.reply","request_id":"q","answer":"Yes"}"#,
                AgentInput::QuestionReply { request_id: "q".into(), answer: "Yes".into() }),
            (r#"{"type":"permission.reply","request_id":"p","decision":"allow_once","message":"Approved"}"#,
                AgentInput::PermissionReply { request_id: "p".into(), decision: Decision::AllowOnce, message: Some("Approved".into()) }),
            (r#"{"type":"interrupt"}"#, AgentInput::Interrupt),
            (r#"{"type":"mode","mode":"plan"}"#, AgentInput::Mode { mode: Mode::Plan }),
            (r#"{"type":"skill","name":"review","enabled":true}"#,
                AgentInput::Skill { name: "review".into(), enabled: true }),
            (r#"{"type":"export_state","request_id":"e","run_id":"r","owner_id":"o"}"#,
                AgentInput::ExportState(ExportStateInput { request_id: "e".into(), run_id: "r".into(), owner_id: "o".into(), quiescent: None, boundary_id: None, hold: false })),
            (r#"{"type":"import_state","request_id":"i","run_id":"r","owner_id":"o","state":{}}"#,
                AgentInput::ImportState(ImportStateInput { request_id: "i".into(), run_id: "r".into(), owner_id: "o".into(), state: serde_json::json!({}) })),
        ];
        for (wire, expected) in frames {
            assert_eq!(decode_input(wire).unwrap(), expected, "rejected {wire}");
            if !matches!(expected, AgentInput::ExportState(_) | AgentInput::ImportState(_) | AgentInput::CheckpointRelease(_)) {
                let mut extended: serde_json::Value = serde_json::from_str(wire).unwrap();
                extended["api_metadata"] = serde_json::json!({"ignored": true});
                assert_eq!(decode_input(&extended.to_string()).unwrap(), expected);
            }
        }
    }

    #[test]
    fn state_commands_are_strict_and_bad_commands_have_correlated_control_errors() {
        assert!(matches!(decode_input(r#"{"type":"export_state","request_id":"e","run_id":"r","owner_id":"o"}"#).unwrap(), AgentInput::ExportState(_)));
        let error = decode_input(r#"{"type":"import_state","request_id":"i","run_id":"r","owner_id":"o","state":{},"unexpected":"private data"}"#).unwrap_err().unwrap();
        assert!(matches!(*error, AgentEvent::StateError { request_id, operation, code } if request_id == "i" && operation == "import_state" && code == "invalid_command"));
        let error = decode_input(r#"{"type":"export_state","request_id":"e","run_id":"r","owner_id":"o","unexpected":"private data"}"#).unwrap_err().unwrap();
        assert!(matches!(*error, AgentEvent::StateError { request_id, operation, code } if request_id == "e" && operation == "export_state" && code == "invalid_command"));
        assert!(matches!(decode_input(r#"{"type":"export_state","request_id":"e","run_id":"r","owner_id":"o","quiescent":true,"boundary_id":"1"}"#).unwrap(), AgentInput::ExportState(ExportStateInput { quiescent: Some(true), boundary_id: Some(_), .. })));
        assert!(matches!(decode_input(r#"{"type":"export_state","request_id":"e","run_id":"r","owner_id":"o","quiescent":true,"hold":true}"#).unwrap(), AgentInput::ExportState(ExportStateInput { hold: true, .. })));
        for hold in ["null", "1", "\"true\""] {
            let wire = format!(r#"{{"type":"export_state","request_id":"e","run_id":"r","owner_id":"o","hold":{hold}}}"#);
            assert!(matches!(*decode_input(&wire).unwrap_err().unwrap(), AgentEvent::StateError { code, .. } if code == "invalid_command"));
        }
        assert!(matches!(decode_input(r#"{"type":"checkpoint.release","request_id":"e","boundary_id":"1"}"#).unwrap(), AgentInput::CheckpointRelease(_)));
        let error = decode_input(r#"{"type":"checkpoint.release","request_id":"e","boundary_id":"1","extra":true}"#).unwrap_err().unwrap();
        assert!(matches!(*error, AgentEvent::StateError { operation, code, .. } if operation == "checkpoint.release" && code == "invalid_command"));
        assert!(decode_input("not JSON").unwrap_err().is_none());
    }
}
