use std::io::Write;

use anyhow::Result;
use tokio::io::AsyncBufReadExt;

use crate::agent::AgentHandle;
use crate::agent::events::{AgentEvent, AgentInput};

/// JSONL protocol: AgentInput lines on stdin, AgentEvent lines on stdout. Exits when stdin closes
/// and the current turn has finished.
pub async fn jsonl(mut agent: AgentHandle) -> Result<i32> {
    let input = agent.input.clone();
    let (eof_tx, mut eof_rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<AgentInput>(&line) {
                Ok(i) => {
                    let _ = input.send(i);
                }
                Err(e) => eprintln!("gond-agent: ignoring bad input line: {e}"),
            }
        }
        let _ = eof_tx.send(());
    });

    let mut out = std::io::stdout();
    let mut busy = 0i32;
    let mut stdin_closed = false;
    loop {
        tokio::select! {
            ev = agent.events.recv() => {
                let Some(ev) = ev else { break };
                match &ev {
                    AgentEvent::TurnStart { agent_id } if agent_id == "main" => busy += 1,
                    AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main" => busy -= 1,
                    _ => {}
                }
                writeln!(out, "{}", serde_json::to_string(&ev)?)?;
                out.flush()?;
                if stdin_closed && busy <= 0 && matches!(ev, AgentEvent::TurnEnd { .. } | AgentEvent::Error { .. }) {
                    break;
                }
            }
            _ = &mut eof_rx, if !stdin_closed => {
                stdin_closed = true;
                // Give a just-sent user message a moment to start its turn.
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                if busy <= 0 && agent.events.is_empty() { break; }
            }
        }
    }
    Ok(0)
}
