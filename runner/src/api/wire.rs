//! Gond Agent wire format v1 (container worker ↔ host model proxy). Spec: protocol/README.md. Mirrors api/src/wire.ts.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Opaque {
    pub provider: String,
    pub model: String,
    pub data: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResultPart {
    Text { text: String },
    Image { media_type: String, data: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opaque: Option<Opaque>,
    },
    Reasoning {
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opaque: Option<Opaque>,
    },
    ToolCall {
        id: String,
        name: String,
        input: Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        opaque: Option<Opaque>,
    },
    ToolResult {
        call_id: String,
        name: String,
        content: Vec<ResultPart>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
    /// `data` is base64; `id` names an image uploaded to Gond Agent instead (the API fills in the bytes).
    Image {
        media_type: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        data: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: Role,
    pub content: Vec<Block>,
}

impl Message {
    pub fn user_text(text: impl Into<String>) -> Self {
        Message { role: Role::User, content: vec![Block::Text { text: text.into(), opaque: None }] }
    }

    /// The person's message: their text, then any images they attached.
    pub fn user(text: impl Into<String>, images: Vec<crate::agent::events::ImageInput>) -> Self {
        let mut content = vec![Block::Text { text: text.into(), opaque: None }];
        content.extend(images.into_iter().map(|i| Block::Image { media_type: i.media_type, data: i.data, id: i.id }));
        Message { role: Role::User, content }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reasoning {
    pub effort: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResponsesRequest {
    pub model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    pub messages: Vec<Message>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<ToolDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_output_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<Reasoning>,
    pub metadata: Metadata,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub input_uncached: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

impl Usage {
    /// Tokens the conversation occupies after this response.
    pub fn context_tokens(&self) -> u64 {
        self.input_uncached + self.cache_read + self.cache_write + self.output
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    Start,
    BlockStart { index: usize, kind: String, id: Option<String>, name: Option<String> },
    BlockDelta { index: usize, text: Option<String>, partial_json: Option<String> },
    BlockEnd { index: usize, input: Option<Value>, opaque: Option<Opaque> },
    End { stop_reason: String, usage: Usage },
    Error { code: String, message: String, retryable: bool },
}

impl StreamEvent {
    /// Decode one SSE record. Unknown events are ignored (forward compatibility).
    pub fn decode(event: &str, data: &str) -> anyhow::Result<Option<StreamEvent>> {
        let v: Value = serde_json::from_str(data)?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
        let idx = || v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        Ok(Some(match event {
            "response.start" => StreamEvent::Start,
            "block.start" => StreamEvent::BlockStart { index: idx(), kind: s("type").unwrap_or_default(), id: s("id"), name: s("name") },
            "block.delta" => StreamEvent::BlockDelta { index: idx(), text: s("text"), partial_json: s("partial_json") },
            "block.end" => StreamEvent::BlockEnd {
                index: idx(),
                input: v.get("input").cloned(),
                opaque: v.get("opaque").map(|o| serde_json::from_value(o.clone())).transpose()?,
            },
            "response.end" => StreamEvent::End {
                stop_reason: s("stop_reason").unwrap_or_else(|| "end_turn".into()),
                usage: v.get("usage").map(|u| serde_json::from_value(u.clone())).transpose()?.unwrap_or_default(),
            },
            "error" => StreamEvent::Error {
                code: s("code").unwrap_or_else(|| "error".into()),
                message: s("message").unwrap_or_default(),
                retryable: v.get("retryable").and_then(Value::as_bool).unwrap_or(false),
            },
            _ => return Ok(None),
        }))
    }
}

/// Assembles a streamed assistant message from block events.
#[derive(Default)]
pub struct MessageBuilder {
    blocks: Vec<PartialBlock>,
}

enum PartialBlock {
    Text(String, Option<Opaque>),
    Reasoning(String, Option<Opaque>),
    Tool { id: String, name: String, json: String, input: Option<Value>, opaque: Option<Opaque> },
}

impl MessageBuilder {
    pub fn apply(&mut self, ev: &StreamEvent) {
        match ev {
            StreamEvent::BlockStart { index, kind, id, name } => {
                let b = match kind.as_str() {
                    "reasoning" => PartialBlock::Reasoning(String::new(), None),
                    "tool_call" => PartialBlock::Tool {
                        id: id.clone().unwrap_or_default(),
                        name: name.clone().unwrap_or_default(),
                        json: String::new(),
                        input: None,
                        opaque: None,
                    },
                    _ => PartialBlock::Text(String::new(), None),
                };
                if *index >= self.blocks.len() {
                    self.blocks.push(b);
                } else {
                    self.blocks[*index] = b;
                }
            }
            StreamEvent::BlockDelta { index, text, partial_json } => match self.blocks.get_mut(*index) {
                Some(PartialBlock::Text(s, _)) | Some(PartialBlock::Reasoning(s, _)) => {
                    if let Some(t) = text {
                        s.push_str(t)
                    }
                }
                Some(PartialBlock::Tool { json, .. }) => {
                    if let Some(p) = partial_json {
                        json.push_str(p)
                    }
                }
                None => {}
            },
            StreamEvent::BlockEnd { index, input: inp, opaque: op } => match self.blocks.get_mut(*index) {
                Some(PartialBlock::Text(_, o)) | Some(PartialBlock::Reasoning(_, o)) => *o = op.clone(),
                Some(PartialBlock::Tool { input, opaque, json, .. }) => {
                    *input = inp.clone().or_else(|| serde_json::from_str(json).ok());
                    *opaque = op.clone();
                }
                None => {}
            },
            _ => {}
        }
    }

    pub fn finish(self) -> Message {
        let content = self
            .blocks
            .into_iter()
            .filter_map(|b| match b {
                PartialBlock::Text(text, opaque) => (!text.is_empty() || opaque.is_some()).then_some(Block::Text { text, opaque }),
                PartialBlock::Reasoning(text, opaque) => Some(Block::Reasoning { text, opaque }),
                PartialBlock::Tool { id, name, json, input, opaque } => Some(Block::ToolCall {
                    id,
                    name,
                    input: input.or_else(|| serde_json::from_str(&json).ok()).unwrap_or_else(|| Value::Object(Default::default())),
                    opaque,
                }),
            })
            .collect();
        Message { role: Role::Assistant, content }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_message_from_events() {
        let evs = [
            ("block.start", json!({"index":0,"type":"reasoning"})),
            ("block.delta", json!({"index":0,"text":"hmm"})),
            ("block.end", json!({"index":0,"opaque":{"provider":"anthropic","model":"m","data":{"signature":"s"}}})),
            ("block.start", json!({"index":1,"type":"text"})),
            ("block.delta", json!({"index":1,"text":"hi"})),
            ("block.end", json!({"index":1})),
            ("block.start", json!({"index":2,"type":"tool_call","id":"t1","name":"read"})),
            ("block.delta", json!({"index":2,"partial_json":"{\"path\":"})),
            ("block.delta", json!({"index":2,"partial_json":"\"a\"}"})),
            ("block.end", json!({"index":2,"input":{"path":"a"}})),
        ];
        let mut b = MessageBuilder::default();
        for (e, d) in evs {
            b.apply(&StreamEvent::decode(e, &d.to_string()).unwrap().unwrap());
        }
        let m = b.finish();
        assert_eq!(m.content.len(), 3);
        assert!(matches!(&m.content[0], Block::Reasoning { text, opaque: Some(_) } if text == "hmm"));
        assert!(matches!(&m.content[2], Block::ToolCall { input, .. } if input == &json!({"path":"a"})));
        let wire = serde_json::to_value(&m).unwrap();
        assert_eq!(wire["content"][2]["type"], "tool_call");
        assert_eq!(wire["role"], "assistant");
    }
}
