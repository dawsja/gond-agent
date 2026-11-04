use std::io::Write;

use anyhow::Result;
use tokio::io::AsyncBufReadExt;

use crate::agent::AgentHandle;
use crate::agent::events::{AgentEvent, AgentInput};

// Never include checkpoint contents (or serde errors containing field names) in logs.
fn decode_input(line: &str) -> std::result::Result<AgentInput, Option<Box<AgentEvent>>> {
    let value: serde_json::Value = serde_json::from_str(line).map_err(|_| None)?;
    let correlation = value["type"].as_str().filter(|op| matches!(*op, "export_state" | "import_state"))
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
                    if matches!(i, AgentInput::ExportState { .. } | AgentInput::ImportState { .. }) {
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
                    AgentEvent::StateExported { .. } | AgentEvent::StateImported { .. } | AgentEvent::StateError { .. } => pending_controls -= 1,
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

    #[test]
    fn state_commands_are_strict_and_bad_commands_have_correlated_control_errors() {
        assert!(matches!(decode_input(r#"{"type":"export_state","request_id":"e","run_id":"r","owner_id":"o"}"#).unwrap(), AgentInput::ExportState { .. }));
        let error = decode_input(r#"{"type":"import_state","request_id":"i","run_id":"r","owner_id":"o","state":{},"unexpected":"private data"}"#).unwrap_err().unwrap();
        assert!(matches!(*error, AgentEvent::StateError { request_id, operation, code } if request_id == "i" && operation == "import_state" && code == "invalid_command"));
        assert!(decode_input("not JSON").unwrap_err().is_none());
    }
}
