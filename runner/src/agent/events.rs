//! Events exchanged between the container worker and the host.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::permissions::Mode;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuestionOption {
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum AgentEvent {
    #[serde(rename = "session.start")]
    SessionStart { session_id: String, model: String, cwd: String, mode: Mode },
    #[serde(rename = "turn.start")]
    TurnStart { agent_id: String },
    #[serde(rename = "text.delta")]
    TextDelta { agent_id: String, text: String },
    #[serde(rename = "reasoning.delta")]
    ReasoningDelta { agent_id: String, text: String },
    #[serde(rename = "tool.start")]
    ToolStart { agent_id: String, call_id: String, name: String, input: Value, title: String },
    #[serde(rename = "tool.output")]
    ToolOutput { agent_id: String, call_id: String, chunk: String },
    /// Host persists bounded tool images and replaces their bytes with owner-scoped image IDs.
    #[serde(rename = "tool.images")]
    ToolImages { agent_id: String, call_id: String, images: Vec<ImageInput> },
    #[serde(rename = "tool.end")]
    ToolEnd {
        agent_id: String,
        call_id: String,
        ok: bool,
        summary: String,
        output: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        diff: Option<String>,
    },
    #[serde(rename = "todos")]
    Todos { agent_id: String, items: Vec<TodoItem> },
    #[serde(rename = "agent.spawn")]
    AgentSpawn { agent_id: String, parent_id: String, kind: String, description: String },
    #[serde(rename = "agent.status")]
    AgentStatus { agent_id: String, activity: String, tool_count: u32, elapsed_ms: u64 },
    #[serde(rename = "agent.end")]
    AgentEnd { agent_id: String, ok: bool, summary: String },
    #[serde(rename = "permission.request")]
    PermissionRequest { request_id: String, agent_id: String, tool: String, title: String, detail: String, rule: String },
    #[serde(rename = "question")]
    Question { request_id: String, agent_id: String, question: String, options: Vec<QuestionOption> },
    #[serde(rename = "usage")]
    Usage { input: u64, output: u64, cache_read: u64, context_used: u64, context_window: u64 },
    #[serde(rename = "turn.end")]
    TurnEnd { agent_id: String, stop_reason: String },
    /// The history was replaced by a summary; token counts before and (estimated) after.
    #[serde(rename = "compacted")]
    Compacted { before: u64, after: u64 },
    #[serde(rename = "error")]
    Error { agent_id: String, message: String, retryable: bool },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    AllowOnce,
    Always,
    Deny,
}

/// An image the person attached to a message: base64 `data`, or
/// the `id` of an image already uploaded to Gond Agent (cloud runs), whose bytes the API fills in.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ImageInput {
    pub media_type: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub data: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type")]
pub enum AgentInput {
    #[serde(rename = "user")]
    User {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageInput>,
    },
    #[serde(rename = "permission.reply")]
    PermissionReply {
        request_id: String,
        decision: Decision,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "question.reply")]
    QuestionReply { request_id: String, answer: String },
    #[serde(rename = "interrupt")]
    Interrupt,
    /// Summarize the conversation to free up context.
    #[serde(rename = "compact")]
    Compact,
    #[serde(rename = "mode")]
    Mode { mode: Mode },
    #[serde(rename = "model")]
    Model { model: String, context_window: u64 },
    /// Enable or disable a skill; applies from the next model request.
    #[serde(rename = "skill")]
    Skill { name: String, enabled: bool },

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_shapes_match_protocol() {
        let e = AgentEvent::ToolEnd { agent_id: "main".into(), call_id: "c".into(), ok: true, summary: "s".into(), output: "o".into(), diff: None };
        assert_eq!(serde_json::to_string(&e).unwrap(), r#"{"type":"tool.end","agent_id":"main","call_id":"c","ok":true,"summary":"s","output":"o"}"#);
        let i: AgentInput = serde_json::from_str(r#"{"type":"permission.reply","request_id":"r1","decision":"always"}"#).unwrap();
        assert_eq!(i, AgentInput::PermissionReply { request_id: "r1".into(), decision: Decision::Always, message: None });
        let m: AgentInput = serde_json::from_str(r#"{"type":"mode","mode":"plan"}"#).unwrap();
        assert_eq!(m, AgentInput::Mode { mode: Mode::Plan });
        assert_eq!(serde_json::from_str::<AgentInput>(r#"{"type":"interrupt"}"#).unwrap(), AgentInput::Interrupt);
    }
}
