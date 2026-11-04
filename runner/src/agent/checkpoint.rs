//! Runner-local checkpoint contract. See runner/CHECKPOINTS.md; not a model request.
use std::collections::{HashMap, HashSet};
use std::io::Write;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::events::TodoItem;
use crate::api::wire::{Block, Message, ResultPart, Role};

pub const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
pub const SCHEMA_VERSION: u32 = 1;
// Deliberate compatibility epoch, NOT Cargo's package version. Bump for changes to
// history semantics, tool replay, compaction or counter interpretation.
// Epoch 2: sub_counter also records consumed bounded-delegation allowance.
pub const RUNNER_STATE_VERSION: &str = "gond-agent-checkpoint-2";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Counters {
    pub sub_counter: u32,
    pub main_context: u64,
    pub plan_calls: u32,
    pub plan_last: Vec<TodoItem>,
    pub plan_nudges: u32,
    pub turn_compactions: u32,
    pub skipped_history_len: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    pub schema_version: u32,
    pub runner_state_version: String,
    pub run_id: String,
    pub owner_id: String,
    // Stored messages: NEVER ResponsesRequest's newest-eight image serializer.
    pub history: Vec<Message>,
    pub plan: Vec<TodoItem>,
    pub counters: Counters,
}

pub fn valid_binding(run: &str, owner: &str) -> bool {
    [run, owner].iter().all(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
}

fn bounded_plan(plan: &[TodoItem]) -> bool {
    plan.len() <= 50 && plan.iter().all(|s| s.text.chars().count() <= 300)
}

// Bound serialization without allocating an arbitrarily large intermediate JSON buffer.
pub fn json_bytes(value: &impl Serialize) -> Result<Vec<u8>, &'static str> {
    struct Bounded(Vec<u8>);
    impl Write for Bounded {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > MAX_STATE_BYTES {
                return Err(std::io::Error::other("checkpoint size limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> { Ok(()) }
    }
    let mut out = Bounded(Vec::new());
    serde_json::to_writer(&mut out, value).map_err(|_| "state_too_large")?;
    Ok(out.0)
}

impl Checkpoint {
    pub fn validate(&self, run: &str, owner: &str) -> Result<(), &'static str> {
        if self.schema_version != SCHEMA_VERSION || self.runner_state_version != RUNNER_STATE_VERSION {
            return Err("incompatible_version");
        }
        if !valid_binding(run, owner) || self.run_id != run || self.owner_id != owner {
            return Err("binding_mismatch");
        }
        if !bounded_plan(&self.plan) || !bounded_plan(&self.counters.plan_last)
            || self.counters.plan_nudges > 2 || self.counters.turn_compactions > 5
            || self.counters.sub_counter == u32::MAX
            || self.counters.skipped_history_len.is_some_and(|n| n > self.history.len()) {
            return Err("invalid_counters_or_plan");
        }
        let mut pending: HashMap<&str, &str> = HashMap::new();
        let mut seen = HashSet::new();
        for message in &self.history {
            if message.role != Role::Tool && !pending.is_empty() { return Err("unpaired_tools"); }
            if message.role == Role::Tool && (pending.is_empty() || message.content.is_empty()) { return Err("unpaired_tools"); }
            for block in &message.content {
                match (message.role, block) {
                    (Role::User, Block::Text { opaque: None, .. } | Block::Image { .. }) => {}
                    (Role::Assistant, Block::Text { .. } | Block::Reasoning { .. }) => {}
                    (Role::Assistant, Block::ToolCall { id, name, input, .. }) => {
                        if id.is_empty() || name.is_empty() || !input.is_object() || !seen.insert(id) {
                            return Err("invalid_tool_call");
                        }
                        pending.insert(id.as_str(), name.as_str());
                    }
                    (Role::Tool, Block::ToolResult { call_id, name, .. }) => {
                        if pending.remove(call_id.as_str()) != Some(name.as_str()) { return Err("unpaired_tools"); }
                    }
                    _ => return Err("invalid_role_placement"),
                }
            }
        }
        if !pending.is_empty() { return Err("unpaired_tools"); }
        Ok(())
    }

    pub async fn import(value: Value, run: &str, owner: &str) -> Result<Self, &'static str> {
        let bytes = json_bytes(&value)?;
        let mut state: Self = serde_json::from_slice(&bytes).map_err(|_| "invalid_schema")?;
        state.validate(run, owner)?;
        // All images, including old tool results, use the same bounded raster policy.
        // A bad image rejects the import transaction rather than silently losing history.
        for message in &mut state.history {
            for block in &mut message.content {
                match block {
                    Block::Image { media_type, data, .. } => {
                        let (kind, normalised) = crate::images::normalise_base64(std::mem::take(data)).await.map_err(|_| "invalid_image")?;
                        *media_type = kind;
                        *data = normalised;
                    }
                    Block::ToolResult { content, .. } => for part in content {
                        if let ResultPart::Image { media_type, data } = part {
                            let (kind, normalised) = crate::images::normalise_base64(std::mem::take(data)).await.map_err(|_| "invalid_image")?;
                            *media_type = kind;
                            *data = normalised;
                        }
                    },
                    _ => {}
                }
            }
        }
        // Normalisation can expand a tiny compressed image.
        json_bytes(&state)?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::events::TodoStatus;
    use crate::api::wire::Opaque;
    use serde_json::json;

    fn fixture() -> Checkpoint {
        let plan = vec![TodoItem { text: "Continue implementation".into(), status: TodoStatus::InProgress }];
        Checkpoint {
            schema_version: SCHEMA_VERSION, runner_state_version: RUNNER_STATE_VERSION.into(),
            run_id: "run".into(), owner_id: "owner".into(),
            history: vec![
                Message::user_text(format!("{}\nWorking notes: summary", super::super::compaction::SUMMARY_PREFIX)),
                Message { role: Role::Assistant, content: vec![
                    Block::Reasoning { text: "thinking".into(), opaque: Some(Opaque { provider: "p".into(), model: "m".into(), data: json!({"signature":"sig"}) }) },
                    Block::ToolCall { id: "call".into(), name: "read".into(), input: json!({"path":"a"}), opaque: None },
                ] },
                Message { role: Role::Tool, content: vec![Block::ToolResult {
                    call_id: "call".into(), name: "read".into(), content: vec![ResultPart::Text { text: "file contents".into() }], is_error: false,
                }] },
            ],
            counters: Counters { sub_counter: 7, main_context: 1234, plan_calls: 8, plan_last: plan.clone(), plan_nudges: 1, turn_compactions: 2, skipped_history_len: Some(3) },
            plan,
        }
    }

    #[tokio::test]
    async fn history_summary_plan_and_counters_roundtrip() {
        let state = fixture();
        let value = serde_json::from_slice(&json_bytes(&state).unwrap()).unwrap();
        assert_eq!(Checkpoint::import(value, "run", "owner").await.unwrap(), state);
    }

    #[tokio::test]
    async fn rejects_schema_pairing_role_version_binding_and_size() {
        let good = serde_json::to_value(fixture()).unwrap();
        let cases = [
            ("/schema_version", json!(2)),
            ("/runner_state_version", json!("future")),
            ("/runner_state_version", json!("gond-agent-checkpoint-1")),
            ("/run_id", json!("other")),
            ("/owner_id", json!("other")),
            ("/history/0/role", json!("system")),
            ("/history/1/content/1/id", json!("unpaired")),
            ("/history/2/content/0/name", json!("write")),
            ("/history/2/role", json!("assistant")),
            ("/history/0/content", json!([{"type":"tool_call","id":"evil","name":"read","input":{}}])),
            ("/plan", json!([{"text":"x".repeat(301),"status":"pending"}])),
            ("/plan", json!(vec![json!({"text":"step","status":"pending"}); 51])),
            ("/counters/plan_nudges", json!(3)),
        ];
        for (path, replacement) in cases {
            let mut bad = good.clone();
            *bad.pointer_mut(path).unwrap() = replacement;
            assert!(Checkpoint::import(bad, "run", "owner").await.is_err(), "accepted {path}");
        }
        for path in ["", "/counters", "/counters/plan_last/0", "/plan/0", "/history/0", "/history/0/content/0", "/history/1/content/0/opaque", "/history/1/content/1", "/history/2/content/0", "/history/2/content/0/content/0"] {
            let mut bad = good.clone();
            bad.pointer_mut(path).unwrap().as_object_mut().unwrap().insert("unknown".into(), json!(true));
            assert_eq!(Checkpoint::import(bad, "run", "owner").await.unwrap_err(), "invalid_schema", "accepted {path}");
        }
        let mut bad = good.clone();
        bad["history"][0]["content"][0]["text"] = json!("x".repeat(MAX_STATE_BYTES));
        assert_eq!(Checkpoint::import(bad, "run", "owner").await.unwrap_err(), "state_too_large");
        let mut unpaired = fixture();
        unpaired.history.pop();
        unpaired.counters.skipped_history_len = None;
        assert_eq!(unpaired.validate("run", "owner"), Err("unpaired_tools"));
        let mut duplicate = fixture();
        let call = duplicate.history[1].content[1].clone();
        duplicate.history[1].content.push(call);
        assert_eq!(duplicate.validate("run", "owner"), Err("invalid_tool_call"));
    }

    #[tokio::test]
    async fn all_stored_images_survive_export_and_import_uses_raster_policy() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(4, 4).write_to(&mut png, image::ImageFormat::Png).unwrap();
        let data = STANDARD.encode(png.into_inner());
        let mut state = fixture();
        state.history[0].content.extend((0..6).map(|_| Block::Image { media_type: "not-trusted".into(), data: data.clone(), id: None }));
        let Block::ToolResult { content, .. } = &mut state.history[2].content[0] else { unreachable!() };
        content.extend((0..6).map(|_| ResultPart::Image { media_type: "not-trusted".into(), data: data.clone() }));
        let bytes = json_bytes(&state).unwrap();
        assert_eq!(String::from_utf8(bytes.clone()).unwrap().matches("\"type\":\"image\"").count(), 12);
        assert_eq!(serde_json::to_string(&crate::images::for_request(&state.history)).unwrap().matches("\"type\":\"image\"").count(), 8);
        let imported = Checkpoint::import(serde_json::from_slice(&bytes).unwrap(), "run", "owner").await.unwrap();
        let Block::Image { media_type, data, .. } = &imported.history[0].content[1] else { panic!("image lost") };
        assert_eq!(media_type, "image/jpeg");
        assert_eq!(image::guess_format(&STANDARD.decode(data).unwrap()).unwrap(), image::ImageFormat::Jpeg);
        let Block::ToolResult { content, .. } = &imported.history[2].content[0] else { unreachable!() };
        assert!(matches!(&content[1], ResultPart::Image { media_type, .. } if media_type == "image/jpeg"));
        assert_eq!(json_bytes(&imported).unwrap().windows(b"\"type\":\"image\"".len()).filter(|w| *w == b"\"type\":\"image\"").count(), 12);
        state.history[0].content[1] = Block::Image { media_type: "image/png".into(), data: "invalid".into(), id: None };
        assert_eq!(Checkpoint::import(serde_json::to_value(state).unwrap(), "run", "owner").await.unwrap_err(), "invalid_image");
    }
}
