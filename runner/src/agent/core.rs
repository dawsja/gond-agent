//! The agent loop: stream a model response, run its tool calls (asking permission when needed),
//! repeat until the model stops. Frontends talk to it only through AgentInput / AgentEvent.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use futures::{FutureExt, StreamExt};
use futures::future::{BoxFuture, join_all};
use serde_json::{Value, json};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::events::{AgentEvent, AgentInput, Decision, ImageInput, QuestionOption, TodoItem};
use super::completion::{self, Completion, Evidence};
use crate::api::wire::{Block, Message, MessageBuilder, Metadata, Reasoning, ResponsesRequest, ResultPart, Role, StreamEvent, ToolDef};
use crate::api::{ApiClient, ApiError};
use crate::permissions::{self, Access, Mode, Rule, Verdict};
use crate::skills::{self, Skill};
use crate::tools::{Baseline, ReadSet, Shells, Tool, ToolCtx, schema, str_arg};

pub struct AgentConfig {
    pub model: String,
    pub context_window: u64,
    pub mode: Mode,
    pub rules: Vec<Rule>,
    pub cwd: PathBuf,
    pub effort: String,
    pub session_id: String,
    /// Earlier messages when resuming a session.
    pub history: Vec<Message>,
    /// When false (headless), permission prompts and questions are answered automatically.
    pub interactive: bool,
    /// Require verification and self-review before a coding turn may end successfully.
    pub require_review: bool,
    /// Tools available inside the workspace container.
    pub tools: Vec<Arc<dyn Tool>>,
    pub system: String,
    pub sub_system: String,
    pub skills: Vec<Skill>,
}

pub struct AgentHandle {
    pub input: UnboundedSender<AgentInput>,
    pub events: UnboundedReceiver<AgentEvent>,
}

enum Reply {
    Permission(Decision, Option<String>),
    Answer(String),
}

struct Shared {
    api: ApiClient,
    events: UnboundedSender<AgentEvent>,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
    mode: Mutex<Mode>,
    rules: Mutex<Vec<Rule>>,
    model: Mutex<(String, u64)>,
    effort: String,
    tools: Vec<Arc<dyn Tool>>,
    reads: ReadSet,
    shells: Shells,
    baseline: Baseline,
    plan: Mutex<Vec<TodoItem>>,
    cwd: PathBuf,
    session_id: String,
    system: String,
    sub_system: String,
    locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    turn_cancel: Mutex<CancellationToken>,
    interactive: bool,
    sub_counter: AtomicU32,
    main_context: Mutex<u64>,
    skills: Mutex<Vec<Skill>>,
    require_review: bool,
    completion: Mutex<Completion>,
}

impl Shared {
    fn emit(&self, e: AgentEvent) {
        let _ = self.events.send(e);
    }

    fn resolve(&self, id: &str, r: Reply) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(r);
        }
    }

    async fn wait_reply(&self, event: AgentEvent, id: String, cancel: &CancellationToken) -> Option<Reply> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        self.emit(event);
        tokio::select! {
            r = rx => r.ok(),
            _ = cancel.cancelled() => { self.pending.lock().unwrap().remove(&id); None }
        }
    }

    fn lock_for(&self, path: PathBuf) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().unwrap().entry(path).or_default().clone()
    }
}

#[derive(Clone)]
struct Run {
    id: String,
    /// None for the main agent, else the subagent kind ("explore" is read-only).
    kind: Option<String>,
}

impl Run {
    fn is_sub(&self) -> bool {
        self.kind.is_some()
    }
}

pub fn spawn(api: ApiClient, cfg: AgentConfig) -> AgentHandle {
    let (ev_tx, ev_rx) = unbounded_channel();
    let (in_tx, mut in_rx) = unbounded_channel::<AgentInput>();
    let (user_tx, mut user_rx) = unbounded_channel::<Work>();

    let shared = Arc::new(Shared {
        api,
        events: ev_tx,
        pending: Mutex::default(),
        mode: Mutex::new(cfg.mode),
        rules: Mutex::new(cfg.rules),
        model: Mutex::new((cfg.model.clone(), cfg.context_window)),
        effort: cfg.effort,
        tools: cfg.tools,
        reads: ReadSet::default(),
        shells: Shells::default(),
        baseline: Baseline::default(),
        plan: Mutex::default(),
        cwd: cfg.cwd.clone(),
        session_id: cfg.session_id.clone(),
        system: cfg.system,
        sub_system: cfg.sub_system,
        locks: Mutex::default(),
        turn_cancel: Mutex::new(CancellationToken::new()),
        interactive: cfg.interactive,
        sub_counter: AtomicU32::new(0),
        main_context: Mutex::new(0),
        skills: Mutex::new(cfg.skills),
        require_review: cfg.require_review,
        completion: Mutex::default(),
    });
    shared.emit(AgentEvent::SessionStart {
        session_id: cfg.session_id,
        model: cfg.model,
        cwd: cfg.cwd.display().to_string(),
        mode: cfg.mode,
    });

    let s = shared.clone();
    tokio::spawn(async move {
        while let Some(input) = in_rx.recv().await {
            match input {
                AgentInput::User { text, images } => {
                    let _ = user_tx.send(Work::User(text, images));
                }
                AgentInput::PermissionReply { request_id, decision, message } => s.resolve(&request_id, Reply::Permission(decision, message)),
                AgentInput::QuestionReply { request_id, answer } => s.resolve(&request_id, Reply::Answer(answer)),
                AgentInput::Interrupt => s.turn_cancel.lock().unwrap().cancel(),
                AgentInput::Mode { mode } => *s.mode.lock().unwrap() = mode,
                AgentInput::Model { model, context_window } => *s.model.lock().unwrap() = (model, context_window),
                AgentInput::Compact => {
                    let _ = user_tx.send(Work::Compact);
                }
                AgentInput::Skill { name, enabled } => {
                    for sk in s.skills.lock().unwrap().iter_mut().filter(|k| k.name == name) {
                        sk.enabled = enabled;
                    }
                }
            }
        }
    });

    let s = shared;
    let mut history = cfg.history;
    tokio::spawn(async move {
        while let Some(work) = user_rx.recv().await {
            let cancel = CancellationToken::new();
            *s.turn_cancel.lock().unwrap() = cancel.clone();
            let (text, images) = match work {
                Work::Compact => {
                    compact(&s, &mut history, &cancel).await;
                    continue;
                }
                Work::User(text, images) => (text, images),
            };
            *s.completion.lock().unwrap() = Completion { web_app: completion::is_web_app(&s.cwd), ..Default::default() };
            // Auto-compact before a turn once the conversation fills most of the window.
            let window = s.model.lock().unwrap().1;
            if window > 0 && *s.main_context.lock().unwrap() * 100 >= window * AUTO_COMPACT_PCT && history.len() > 2 {
                compact(&s, &mut history, &cancel).await;
            }
            let start = history.len();
            history.push(Message::user(text, images));
            let main = Run { id: "main".into(), kind: None };
            // A bug in a turn ends that turn with an error, instead of leaving it (and a cloud run) hanging.
            let result = match std::panic::AssertUnwindSafe(run_loop(&s, &main, &mut history, &cancel)).catch_unwind().await {
                Ok(r) => r,
                Err(_) => {
                    history.truncate(start + 1);
                    Err(anyhow!("Something went wrong in Gond Agent during this turn. Try again."))
                }
            };
            if let Err(e) = result {
                let retryable = e.downcast_ref::<ApiError>().is_some_and(|a| a.retryable);
                s.emit(AgentEvent::Error { agent_id: "main".into(), message: s.api.describe(&e), retryable });
            }
        }
    });

    AgentHandle { input: in_tx, events: ev_rx }
}

enum Work {
    User(String, Vec<ImageInput>),
    Compact,
}

const AUTO_COMPACT_PCT: u64 = 85;

const COMPACT_PROMPT: &str = "Summarize this conversation so the work can continue in a fresh context window. Write it as working notes to yourself: the user's goals and constraints; decisions made and why; files read or changed (with paths) and what changed; commands run and their results; errors hit and how they were resolved; the current plan with what is done and what remains; anything the user asked you to remember. Be complete but concise. Do not call any tools.";

const SUMMARY_PREFIX: &str = "This session continues an earlier conversation that was compacted to save context. Summary of everything so far:";


/// One model call that writes about the conversation (a compaction summary) without
/// changing it. `id` names the run, which keeps the text out of the transcript.
async fn summarize(s: &Arc<Shared>, history: &[Message], prompt: &str, id: &str, cancel: &CancellationToken) -> Streamed {
    let mut messages = history.to_vec();
    messages.push(Message::user_text(prompt));
    let mut tools: Vec<ToolDef> = s.tools.iter().map(|t| t.def()).collect();
    tools.extend(agent_tool_defs(false));
    let (model, _) = s.model.lock().unwrap().clone();
    let req = ResponsesRequest {
        model,
        system: Some(s.system.clone()),
        messages,
        tools,
        max_output_tokens: Some(8000),
        reasoning: Some(Reasoning { effort: "low".into() }),
        metadata: Metadata { session_id: Some(s.session_id.clone()), agent_id: Some(id.into()) },
    };
    let run = Run { id: id.into(), kind: Some(id.into()) };
    stream_once(s, &run, &req, cancel).await
}

/// "Title: x\n\nnotes" → ("x", "notes"). Without a title line, everything is notes.
/// Replace the history with a model-written summary (keeps the session going in a fresh window).
async fn compact(s: &Arc<Shared>, history: &mut Vec<Message>, cancel: &CancellationToken) {
    if history.is_empty() {
        s.emit(AgentEvent::Error { agent_id: "main".into(), message: "nothing to compact yet".into(), retryable: false });
        return;
    }
    s.emit(AgentEvent::TurnStart { agent_id: "main".into() });
    let before = *s.main_context.lock().unwrap();
    match summarize(s, history, COMPACT_PROMPT, "compact", cancel).await {
        Streamed::Done(msg, _) if !final_text(&msg).trim().is_empty() => {
            let summary = Message::user_text(format!("{SUMMARY_PREFIX}\n\n{}", final_text(&msg).trim()));
            *history = vec![summary];
            let after = (final_text(&msg).len() / 4) as u64;
            *s.main_context.lock().unwrap() = after;
            s.emit(AgentEvent::Compacted { before, after });
            s.emit(AgentEvent::TurnEnd { agent_id: "main".into(), stop_reason: "compacted".into() });
        }
        Streamed::Done(..) | Streamed::Cancelled(_) => {
            s.emit(AgentEvent::TurnEnd { agent_id: "main".into(), stop_reason: "interrupted".into() });
        }
        Streamed::Failed(e) => {
            s.emit(AgentEvent::TurnEnd { agent_id: "main".into(), stop_reason: "error".into() });
            s.emit(AgentEvent::Error { agent_id: "main".into(), message: format!("compaction failed: {e}"), retryable: true });
        }
    }
}

fn agent_tool_defs(sub: bool) -> Vec<ToolDef> {
    let mut defs = vec![];
    if !sub {
        defs.push(completion::definition());
        defs.push(ToolDef {
            name: "update_plan".into(),
            description: "Replace the plan shown to the user. Use it for work with several steps; keep exactly one step in_progress while working and mark steps done as soon as they are. Optionally explain what changed.".into(),
            input_schema: schema(
                json!({
                    "explanation": {"type": "string"},
                    "plan": {"type": "array", "items": {"type": "object", "properties": {
                        "step": {"type": "string"},
                        "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}
                    }, "required": ["step", "status"], "additionalProperties": false}}
                }),
                &["plan"],
            ),
        });
        defs.push(ToolDef {
            name: "list_plan".into(),
            description: "Show the current plan with each step's status.".into(),
            input_schema: schema(json!({}), &[]),
        });
        defs.push(ToolDef {
            name: "ask_user".into(),
            description: "Ask the user a multiple-choice question when you are blocked on a decision that is theirs to make. Offer 2-4 options; mark at most one recommended. The user can also type their own answer.".into(),
            input_schema: schema(
                json!({
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "object", "properties": {
                        "label": {"type": "string"},
                        "description": {"type": "string"},
                        "recommended": {"type": "boolean"}
                    }, "required": ["label", "description"], "additionalProperties": false}}
                }),
                &["question", "options"],
            ),
        });
        defs.push(ToolDef {
            name: "task".into(),
            description: "Delegate a self-contained task to a subagent with its own context. kind \"explore\" is read-only (search and read); \"general\" can also edit and run commands. Call task several times in one response to run subagents in parallel. The subagent's final report is returned to you.".into(),
            input_schema: schema(
                json!({
                    "description": {"type": "string", "description": "3-6 word summary shown to the user"},
                    "prompt": {"type": "string", "description": "Complete instructions; the subagent sees nothing else"},
                    "kind": {"type": "string", "enum": ["explore", "general"]}
                }),
                &["description", "prompt"],
            ),
        });
    }
    defs
}

fn tool_visible(t: &dyn Tool, run: &Run) -> bool {
    run.kind.as_deref() != Some("explore") || t.access() == Access::Read
}

fn run_loop<'a>(s: &'a Arc<Shared>, run: &'a Run, history: &'a mut Vec<Message>, cancel: &'a CancellationToken) -> BoxFuture<'a, Result<String>> {
    Box::pin(async move {
        s.emit(AgentEvent::TurnStart { agent_id: run.id.clone() });
        let started = Instant::now();
        let mut tool_count = 0u32;
        let mut rejected_finishes = 0;
        loop {
            if !run.is_sub() {
                for evidence in s.completion.lock().unwrap().evidence.values_mut() { evidence.observed = true; }
            }
            let (model, _) = s.model.lock().unwrap().clone();
            let mut tools: Vec<ToolDef> = s.tools.iter().filter(|t| tool_visible(t.as_ref(), run)).map(|t| t.def()).collect();
            tools.extend(agent_tool_defs(run.is_sub()));
            // Skills are read per request, so /skills toggles apply without restarting.
            let skill_section = {
                let sk = s.skills.lock().unwrap();
                if sk.iter().any(|k| k.enabled) {
                    tools.push(skills::tool_def());
                }
                skills::prompt_section(&sk)
            };
            let req = ResponsesRequest {
                model,
                system: Some(if run.is_sub() {
                    format!("{}{}", s.sub_system, crate::prompt::instructions_section(&s.cwd))
                } else {
                    format!("{}{}{skill_section}", s.system, crate::prompt::instructions_section(&s.cwd))
                }),
                messages: history.clone(),
                tools,
                max_output_tokens: None,
                reasoning: Some(Reasoning { effort: s.effort.clone() }),
                metadata: Metadata { session_id: Some(s.session_id.clone()), agent_id: Some(run.id.clone()) },
            };

            let (msg, stop) = match stream_once(s, run, &req, cancel).await {
                Streamed::Done(m, stop) => (m, stop),
                Streamed::Cancelled(partial) => {
                    if let Some(m) = sanitize_partial(partial) {
                        history.push(m);
                    }
                    s.emit(AgentEvent::TurnEnd { agent_id: run.id.clone(), stop_reason: "interrupted".into() });
                    return Ok(String::new());
                }
                Streamed::Failed(e) => {
                    s.emit(AgentEvent::TurnEnd { agent_id: run.id.clone(), stop_reason: "error".into() });
                    return Err(e);
                }
            };
            let text = final_text(&msg);
            let calls: Vec<(String, String, Value)> = msg
                .content
                .iter()
                .filter_map(|b| if let Block::ToolCall { id, name, input, .. } = b { Some((id.clone(), name.clone(), input.clone())) } else { None })
                .collect();
            history.push(msg);
            if calls.is_empty() {
                if !run.is_sub() && s.require_review && s.completion.lock().unwrap().required {
                    let ctx = tool_context(s, run, "finish", cancel);
                    let fingerprint = completion::fingerprint(&ctx).await;
                    let approved = fingerprint.is_some() && s.completion.lock().unwrap().approved == fingerprint;
                    if !approved {
                        rejected_finishes += 1;
                        if rejected_finishes >= 3 {
                            s.emit(AgentEvent::TurnEnd { agent_id: run.id.clone(), stop_reason: "error".into() });
                            return Err(anyhow!("Verification and self-review are incomplete. The run has not been marked done."));
                        }
                        history.push(Message::user_text("Completion blocked: understand the code, justify the design, run relevant verification, inspect the final diff and review your changes. For web apps run browser interactions/assertions and inspect both screenshots. Call finish_review with current successful evidence before ending. If blocked, call finish_review with blocked=true and explain limitations; do not claim done."));
                        continue;
                    }
                }
                s.emit(AgentEvent::TurnEnd { agent_id: run.id.clone(), stop_reason: stop });
                return Ok(text);
            }

            let parallel = calls.iter().all(|(_, name, _)| name == "task" || s.tools.iter().any(|t| t.name() == name && t.access() == Access::Read));
            let turn = Turn { run, cancel, started, tool_count };
            let results: Vec<Block> = if parallel {
                join_all(calls.into_iter().map(|(id, name, input)| run_call(s, turn, id, name, input))).await
            } else {
                let mut out = vec![];
                for (id, name, input) in calls {
                    out.push(run_call(s, turn, id, name, input).await);
                }
                out
            };
            tool_count += results.len() as u32;
            history.push(Message { role: Role::Tool, content: results });
            let blocker = if !run.is_sub() { s.completion.lock().unwrap().blocker.clone() } else { None };
            if let Some(blocker) = blocker {
                s.emit(AgentEvent::TurnEnd { agent_id: run.id.clone(), stop_reason: "error".into() });
                return Err(anyhow!("Verification blocked: {blocker}"));
            }
            if cancel.is_cancelled() {
                s.emit(AgentEvent::TurnEnd { agent_id: run.id.clone(), stop_reason: "interrupted".into() });
                return Ok(text);
            }
        }
    })
}

enum Streamed {
    Done(Message, String),
    Cancelled(Message),
    Failed(anyhow::Error),
}

fn retryable(e: &anyhow::Error) -> bool {
    match e.downcast_ref::<ApiError>() {
        Some(a) => a.retryable,
        None => e.downcast_ref::<reqwest::Error>().is_some_and(|r| r.is_connect() || r.is_timeout() || r.is_request()),
    }
}

async fn stream_once(s: &Arc<Shared>, run: &Run, req: &ResponsesRequest, cancel: &CancellationToken) -> Streamed {
    const ATTEMPTS: u32 = 4;
    'attempt: for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))) => {}
                _ = cancel.cancelled() => return Streamed::Cancelled(MessageBuilder::default().finish()),
            }
        }
        let opened = tokio::select! {
            r = s.api.responses(req) => r,
            _ = cancel.cancelled() => return Streamed::Cancelled(MessageBuilder::default().finish()),
        };
        let mut stream = match opened {
            Ok(st) => st,
            Err(e) if retryable(&e) && attempt + 1 < ATTEMPTS => continue 'attempt,
            Err(e) => return Streamed::Failed(e),
        };
        let mut builder = MessageBuilder::default();
        // Each block's kind by its index (the model's numbers: a map, so a huge one can't allocate).
        let mut kinds: HashMap<usize, String> = HashMap::new();
        let mut produced = false;
        loop {
            let next = tokio::select! {
                n = stream.next() => n,
                _ = cancel.cancelled() => return Streamed::Cancelled(builder.finish()),
            };
            let ev = match next {
                None => {
                    if !produced && attempt + 1 < ATTEMPTS {
                        continue 'attempt;
                    }
                    return Streamed::Failed(anyhow!("The connection to Gond Agent dropped before the reply finished. Try again."));
                }
                Some(Err(e)) => {
                    if !produced && retryable(&e) && attempt + 1 < ATTEMPTS {
                        continue 'attempt;
                    }
                    return Streamed::Failed(e);
                }
                Some(Ok(ev)) => ev,
            };
            match &ev {
                StreamEvent::BlockStart { index, kind, .. } => {
                    kinds.insert(*index, kind.clone());
                }
                StreamEvent::BlockDelta { index, text: Some(t), .. } => {
                    produced = true;
                    let agent_id = run.id.clone();
                    let text = t.clone();
                    s.emit(if kinds.get(index).is_some_and(|k| k == "reasoning") {
                        AgentEvent::ReasoningDelta { agent_id, text }
                    } else {
                        AgentEvent::TextDelta { agent_id, text }
                    });
                }
                StreamEvent::BlockDelta { .. } => produced = true,
                StreamEvent::End { stop_reason, usage } => {
                    let context_used = if run.is_sub() {
                        *s.main_context.lock().unwrap()
                    } else {
                        let used = usage.context_tokens();
                        *s.main_context.lock().unwrap() = used;
                        used
                    };
                    let (_, window) = s.model.lock().unwrap().clone();
                    s.emit(AgentEvent::Usage {
                        input: usage.input_uncached + usage.cache_read + usage.cache_write,
                        output: usage.output,
                        cache_read: usage.cache_read,
                        context_used,
                        context_window: window,
                    });
                    let stop = stop_reason.clone();
                    builder.apply(&ev);
                    return Streamed::Done(builder.finish(), stop);
                }
                StreamEvent::Error { code, message, retryable } => {
                    if *retryable && !produced && attempt + 1 < ATTEMPTS {
                        continue 'attempt;
                    }
                    return Streamed::Failed(ApiError { code: code.clone(), message: message.clone(), retryable: *retryable }.into());
                }
                StreamEvent::Start | StreamEvent::BlockEnd { .. } => {}
            }
            builder.apply(&ev);
        }
    }
    Streamed::Failed(anyhow!("Gond Agent didn't respond after {ATTEMPTS} tries. Try again in a moment."))
}

/// Keep only what can be replayed from an interrupted response: text, no half-written tool calls.
fn sanitize_partial(m: Message) -> Option<Message> {
    let content: Vec<Block> = m.content.into_iter().filter(|b| matches!(b, Block::Text { text, .. } if !text.is_empty())).collect();
    (!content.is_empty()).then_some(Message { role: Role::Assistant, content })
}

fn final_text(m: &Message) -> String {
    m.content.iter().filter_map(|b| if let Block::Text { text, .. } = b { Some(text.as_str()) } else { None }).collect::<Vec<_>>().join("\n")
}

fn result(call_id: String, name: String, text: impl Into<String>, is_error: bool) -> Block {
    Block::ToolResult { call_id, name, content: vec![ResultPart::Text { text: text.into() }], is_error }
}

/// What a tool call needs to know about the turn it's part of.
#[derive(Clone, Copy)]
struct Turn<'a> {
    run: &'a Run,
    cancel: &'a CancellationToken,
    started: Instant,
    /// Tool calls so far (a subagent's status line shows it).
    tool_count: u32,
}

async fn run_call(s: &Arc<Shared>, turn: Turn<'_>, id: String, name: String, input: Value) -> Block {
    let Turn { run, cancel, started, tool_count } = turn;
    if cancel.is_cancelled() {
        return result(id, name, "interrupted by the user before this call ran", true);
    }
    match name.as_str() {
        "finish_review" if !run.is_sub() => {
            let ctx = tool_context(s, run, &id, cancel);
            s.emit(AgentEvent::ToolStart { agent_id: run.id.clone(), call_id: id.clone(), name: name.clone(), input: input.clone(), title: "Verification and self-review".into() });
            let verdict = if input["blocked"] == true {
                match str_arg(&input,"limitations").filter(|s| !s.trim().is_empty()) {
                    Some(reason) => { s.completion.lock().unwrap().blocker = Some(reason.chars().take(1000).collect()); Ok(()) }
                    None => Err("Explain the verification blocker in limitations"),
                }
            } else {
                if completion::is_web_app(&s.cwd) { s.completion.lock().unwrap().web_app = true; }
                match completion::fingerprint(&ctx).await {
                    Some(ref hash) => s.completion.lock().unwrap().review(&input, hash),
                    None => Err("Could not verify the worktree; completion remains blocked"),
                }
            };
            let (ok, text) = match verdict {
                Ok(()) if input["blocked"] == true => (true, "Blocker recorded; this run will not be marked done or published."),
                Ok(()) => (true, "Self-review recorded. Summarize the result, verification and limitations; do not claim human approval."),
                Err(e) => (false,e),
            };
            s.emit(AgentEvent::ToolEnd { agent_id: run.id.clone(), call_id: id.clone(), ok, summary: if ok { "self-reviewed".into() } else { "incomplete".into() }, output: text.into(), diff: None });
            return result(id, name, text, !ok);
        }
        "update_plan" => return update_plan(s, run, id, name, &input),
        "list_plan" => return list_plan(s, id, name),
        "ask_user" => return ask_user(s, run, id, name, &input, cancel).await,
        "task" => return task(s, run, id, name, &input, cancel).await,
        "skill" => {
            let skill_name = str_arg(&input, "name").unwrap_or("").to_owned();
            s.emit(AgentEvent::ToolStart { agent_id: run.id.clone(), call_id: id.clone(), name: name.clone(), input: input.clone(), title: skill_name.clone() });
            let loaded = skills::load(&s.skills.lock().unwrap(), &skill_name);
            let (ok, summary, text) = match loaded {
                Ok(t) => (true, "loaded".to_owned(), t),
                Err(e) => (false, "error".to_owned(), e),
            };
            s.emit(AgentEvent::ToolEnd { agent_id: run.id.clone(), call_id: id.clone(), ok, summary, output: String::new(), diff: None });
            return result(id, name, text, !ok);
        }
        _ => {}
    }
    let Some(tool) = s.tools.iter().find(|t| t.name() == name && tool_visible(t.as_ref(), run)).cloned() else {
        return result(id, name.clone(), format!("unknown tool `{name}`"), true);
    };
    let title = tool.title(&input);
    s.emit(AgentEvent::ToolStart { agent_id: run.id.clone(), call_id: id.clone(), name: name.clone(), input: input.clone(), title: title.clone() });
    if run.is_sub() {
        s.emit(AgentEvent::AgentStatus {
            agent_id: run.id.clone(),
            activity: format!("{} {}", name, title),
            tool_count: tool_count + 1,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }

    let target = tool.target(&input);
    let mode = *s.mode.lock().unwrap();
    // "Always allow" rules cover writes only inside the folder, by each file's real path relative to it,
    // and never in .git or .gond-agent. Elsewhere a write asks every time (in Ask mode), with no "always" to
    // remember. Allow mode means allow, here too.
    let write_paths: Option<Vec<String>> = (tool.access() == Access::Write)
        .then(|| tool.paths(&input).iter().map(|p| crate::tools::rule_path(&s.cwd, p)).collect::<Option<Vec<_>>>().filter(|v| !v.is_empty()).unwrap_or_default());
    let unruled = write_paths.as_ref().is_some_and(Vec::is_empty);
    let verdict = {
        let rules = s.rules.lock().unwrap();
        match &write_paths {
            Some(paths) if !paths.is_empty() => paths
                .iter()
                .map(|p| permissions::decide(mode, tool.access(), &name, p, &rules))
                .reduce(|a, b| match (a, b) {
                    (Verdict::Deny(w), _) | (_, Verdict::Deny(w)) => Verdict::Deny(w),
                    (Verdict::Ask, _) | (_, Verdict::Ask) => Verdict::Ask,
                    _ => Verdict::Allow,
                })
                .unwrap_or(Verdict::Ask),
            Some(_) => permissions::decide(mode, tool.access(), &name, &target, &[]),
            None => permissions::decide(mode, tool.access(), &name, &target, &rules),
        }
    };
    let end = |ok: bool, summary: String, output: String, diff: Option<String>| {
        s.emit(AgentEvent::ToolEnd { agent_id: run.id.clone(), call_id: id.clone(), ok, summary, output, diff });
    };
    match verdict {
        Verdict::Allow => {}
        Verdict::Deny(why) => {
            end(false, "blocked".into(), why.clone(), None);
            return result(id, name, why, true);
        }
        Verdict::Ask => {
            let rule = if unruled { String::new() } else { permissions::suggest_rule(&name, &target) };
            if !s.interactive {
                let why = "This tool is not available in this run.".to_owned();
                end(false, "denied".into(), why.clone(), None);
                return result(id, name, why, true);
            }
            let request_id = uuid::Uuid::new_v4().to_string();
            let ev = AgentEvent::PermissionRequest {
                request_id: request_id.clone(),
                agent_id: run.id.clone(),
                tool: name.clone(),
                title: title.clone(),
                detail: permission_detail(&name, &input),
                rule: rule.clone(),
            };
            match s.wait_reply(ev, request_id, cancel).await {
                Some(Reply::Permission(Decision::AllowOnce, _)) => {}
                Some(Reply::Permission(Decision::Always, _)) if rule.is_empty() => {}
                Some(Reply::Permission(Decision::Always, _)) => {
                    if let Some(r) = Rule::parse(&rule) {
                        s.rules.lock().unwrap().push(r);
                    }
                }
                Some(Reply::Permission(Decision::Deny, msg)) => {
                    let why = match msg.filter(|m| !m.trim().is_empty()) {
                        Some(m) => format!("The user denied this call and said: {m}"),
                        None => "The user denied this call. Do not retry it; ask or take a different approach.".into(),
                    };
                    end(false, "denied".into(), String::new(), None);
                    return result(id, name, why, true);
                }
                _ => {
                    end(false, "interrupted".into(), String::new(), None);
                    return result(id, name, "interrupted by the user", true);
                }
            }
        }
    }

    let _guard = match tool.access() {
        Access::Write => Some(s.lock_for(s.cwd.join(str_arg(&input, "path").unwrap_or(""))).lock_owned().await),
        _ => None,
    };
    let ctx = tool_context(s, run, &id, cancel);
    if s.require_review && matches!(tool.access(), Access::Write | Access::Exec) {
        let mut gate = s.completion.lock().unwrap();
        gate.required = true;
        gate.approved = None;
    }
    let evidence = s.require_review && (name == "browser" || (name == "bash" && input["run_in_background"] != true));
    let diff = name == "bash" && str_arg(&input, "command").is_some_and(|c| c.contains("git") && c.contains("diff") && !c.contains("--check"));
    let out = tool.run(&ctx, input).await;
    let images: Vec<_> = out.content.iter().filter_map(|p| match p {
        ResultPart::Image { media_type, data } => Some(ImageInput { media_type: media_type.clone(), data: data.clone(), id: None }),
        _ => None,
    }).take(8).collect();
    if !images.is_empty() {
        s.emit(AgentEvent::ToolImages { agent_id: run.id.clone(), call_id: id.clone(), images });
    }
    if evidence && out.ok {
        if let Some(fingerprint) = completion::fingerprint(&ctx).await {
            let key = if run.is_sub() { format!("{}:{id}", run.id) } else { id.clone() };
            s.completion.lock().unwrap().evidence.insert(key, Evidence {fingerprint, observed:false, browser: name == "browser", diff});
        }
    }
    end(out.ok, out.summary.clone(), out.display.clone(), out.diff.clone());
    Block::ToolResult { call_id: id, name, content: out.content, is_error: !out.ok }
}

fn tool_context(s: &Shared, run: &Run, id: &str, cancel: &CancellationToken) -> ToolCtx {
    ToolCtx { cwd: s.cwd.clone(), agent_id: run.id.clone(), call_id: id.into(), events: s.events.clone(), reads: s.reads.clone(), shells: s.shells.clone(), baseline: s.baseline.clone(), cancel: cancel.clone() }
}

fn permission_detail(name: &str, input: &Value) -> String {
    match name {
        "bash" => String::new(),
        "write" => format!("{} lines", str_arg(input, "content").map(|c| c.lines().count()).unwrap_or(0)),
        "edit" => {
            let old = str_arg(input, "old_string").unwrap_or("");
            let new = str_arg(input, "new_string").unwrap_or("");
            crate::tools::fs::diff(old, new, "").0.lines().skip(3).collect::<Vec<_>>().join("\n")
        }
        _ => serde_json::to_string(input).unwrap_or_default().chars().take(400).collect(),
    }
}

fn update_plan(s: &Arc<Shared>, run: &Run, id: String, name: String, input: &Value) -> Block {
    let parsed: Option<Vec<TodoItem>> = input.get("plan").and_then(Value::as_array).map(|steps| {
        steps
            .iter()
            .filter_map(|st| {
                let text = st.get("step").or(st.get("text")).and_then(Value::as_str)?.to_owned();
                let status = serde_json::from_value(st.get("status").cloned().unwrap_or(json!("pending"))).ok()?;
                Some(TodoItem { text, status })
            })
            .collect()
    });
    let Some(items) = parsed.filter(|i| !i.is_empty()) else {
        return result(id, name, "plan must be a non-empty array of {step, status}", true);
    };
    let done = items.iter().filter(|t| t.status == super::events::TodoStatus::Done).count();
    let summary = format!("{done} of {} done", items.len());
    *s.plan.lock().unwrap() = items.clone();
    s.emit(AgentEvent::Todos { agent_id: run.id.clone(), items });
    result(id, name, format!("Plan updated ({summary})."), false)
}

fn list_plan(s: &Arc<Shared>, id: String, name: String) -> Block {
    let plan = s.plan.lock().unwrap();
    if plan.is_empty() {
        return result(id, name, "No plan yet. Create one with update_plan.", false);
    }
    let text = plan
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let mark = match t.status {
                super::events::TodoStatus::Done => "done",
                super::events::TodoStatus::InProgress => "in_progress",
                super::events::TodoStatus::Pending => "pending",
            };
            format!("{}. [{mark}] {}", i + 1, t.text)
        })
        .collect::<Vec<_>>()
        .join("\n");
    result(id, name, text, false)
}

async fn ask_user(s: &Arc<Shared>, run: &Run, id: String, name: String, input: &Value, cancel: &CancellationToken) -> Block {
    let question = str_arg(input, "question").unwrap_or("").to_owned();
    let options: Vec<QuestionOption> = input.get("options").cloned().and_then(|o| serde_json::from_value(o).ok()).unwrap_or_default();
    if !s.interactive {
        return result(id, name, "The user is not available (non-interactive run). Proceed with your best judgment and state the assumption.", false);
    }
    let request_id = uuid::Uuid::new_v4().to_string();
    let ev = AgentEvent::Question { request_id: request_id.clone(), agent_id: run.id.clone(), question, options };
    match s.wait_reply(ev, request_id, cancel).await {
        Some(Reply::Answer(a)) => result(id, name, format!("The user answered: {a}"), false),
        _ => result(id, name, "The question was dismissed without an answer.", true),
    }
}

async fn task(s: &Arc<Shared>, run: &Run, id: String, name: String, input: &Value, cancel: &CancellationToken) -> Block {
    let (Some(description), Some(prompt)) = (str_arg(input, "description"), str_arg(input, "prompt")) else {
        return result(id, name, "description and prompt are required", true);
    };
    let kind = match str_arg(input, "kind") {
        Some("explore") => "explore",
        _ => "general",
    };
    let n = s.sub_counter.fetch_add(1, Ordering::Relaxed) + 1;
    let sub = Run { id: format!("{kind}-{n}"), kind: Some(kind.to_owned()) };
    s.emit(AgentEvent::AgentSpawn { agent_id: sub.id.clone(), parent_id: run.id.clone(), kind: kind.into(), description: description.into() });
    let mut history = vec![Message::user_text(prompt)];
    match run_loop(s, &sub, &mut history, cancel).await {
        Ok(report) if !cancel.is_cancelled() => {
            let first = report.lines().find(|l| !l.trim().is_empty()).unwrap_or("done").chars().take(120).collect();
            s.emit(AgentEvent::AgentEnd { agent_id: sub.id.clone(), ok: true, summary: first });
            result(id, name, if report.is_empty() { "(the subagent returned no report)".into() } else { report }, false)
        }
        Ok(_) => {
            s.emit(AgentEvent::AgentEnd { agent_id: sub.id.clone(), ok: false, summary: "interrupted".into() });
            result(id, name, "the subagent was interrupted", true)
        }
        Err(e) => {
            s.emit(AgentEvent::AgentEnd { agent_id: sub.id.clone(), ok: false, summary: e.to_string() });
            result(id, name, format!("the subagent failed: {e}"), true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::events::Decision;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;

    type Handler = Arc<dyn Fn(&Value) -> String + Send + Sync>;

    /// Minimal HTTP server answering POST /v1/responses with scripted SSE bodies.
    async fn mock(handler: Handler, seen: Arc<StdMutex<Vec<Value>>>) -> String {
        use crate::tools::testutil::http::{Res, serve};
        serve(move |req| {
            let req = req.json();
            let body = handler(&req);
            seen.lock().unwrap().push(req);
            Res::new(200, "text/event-stream", body)
        })
        .await
    }

    fn sse(blocks: &[Value], stop: &str) -> String {
        let mut s = String::from("event: response.start\ndata: {\"id\":\"r\",\"model\":\"m\"}\n\n");
        for (i, b) in blocks.iter().enumerate() {
            let kind = b["type"].as_str().unwrap();
            s += &format!("event: block.start\ndata: {}\n\n", json!({"index": i, "type": kind, "id": b.get("id"), "name": b.get("name")}));
            if kind == "text" {
                s += &format!("event: block.delta\ndata: {}\n\n", json!({"index": i, "text": b["text"]}));
                s += &format!("event: block.end\ndata: {}\n\n", json!({"index": i}));
            } else {
                s += &format!("event: block.end\ndata: {}\n\n", json!({"index": i, "input": b["input"]}));
            }
        }
        s += &format!(
            "event: response.end\ndata: {}\n\n",
            json!({"stop_reason": stop, "usage": {"input_uncached": 100, "output": 20, "reasoning": 0, "cache_read": 0, "cache_write": 0}})
        );
        s
    }

    fn config(dir: &std::path::Path, mode: Mode) -> AgentConfig {
        AgentConfig {
            model: "m".into(),
            context_window: 1000,
            mode,
            rules: vec![],
            cwd: dir.to_path_buf(),
            effort: "low".into(),
            session_id: "s".into(),
            history: vec![],
            interactive: true,
            require_review: false,
            tools: crate::tools::builtin(),
            system: "sys".into(),
            sub_system: "sub".into(),
            skills: vec![],
        }
    }

    async fn until(h: &mut AgentHandle, pred: impl Fn(&AgentEvent) -> bool) -> Vec<AgentEvent> {
        let mut out = vec![];
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), h.events.recv()).await.expect("timed out").expect("closed");
            let done = pred(&ev);
            out.push(ev);
            if done {
                return out;
            }
        }
    }

    #[tokio::test]
    async fn tool_loop_with_permission_prompt() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "hello\n").unwrap();
        let seen = Arc::new(StdMutex::new(vec![]));
        let handler: Handler = Arc::new(|req: &Value| {
            if req["messages"].as_array().unwrap().len() == 1 {
                sse(
                    &[
                        json!({"type":"text","text":"Reading."}),
                        json!({"type":"tool_call","id":"t1","name":"read","input":{"path":"a.txt"}}),
                        json!({"type":"tool_call","id":"t2","name":"bash","input":{"command":"echo ran"}}),
                    ],
                    "tool_use",
                )
            } else {
                sse(&[json!({"type":"text","text":"Done."})], "end_turn")
            }
        });
        let url = mock(handler, seen.clone()).await;
        let mut h = spawn(ApiClient::new(url, Some("t".into())), config(dir.path(), Mode::Ask));
        h.input.send(AgentInput::User { text: "go".into(), images: vec![] }).unwrap();

        let evs = until(&mut h, |e| matches!(e, AgentEvent::PermissionRequest { .. })).await;
        let AgentEvent::PermissionRequest { request_id, tool, title, rule, .. } = evs.last().unwrap().clone() else { unreachable!() };
        assert_eq!((tool.as_str(), title.as_str(), rule.as_str()), ("bash", "echo ran", "bash: echo ran"));
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::ToolEnd { ok: true, summary, .. } if summary == "1 lines")), "read ran without asking");

        h.input.send(AgentInput::PermissionReply { request_id, decision: Decision::AllowOnce, message: None }).unwrap();
        let evs = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::ToolEnd { ok: true, output, .. } if output == "ran")));
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::TextDelta { text, .. } if text == "Done.")));

        let reqs = seen.lock().unwrap();
        assert_eq!(reqs.len(), 2);
        let msgs = reqs[1]["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[2]["role"], "tool");
        assert_eq!(msgs[2]["content"][0]["call_id"], "t1");
        assert!(msgs[2]["content"][0]["content"][0]["text"].as_str().unwrap().contains("hello"));
        assert_eq!(reqs[1]["tools"].as_array().unwrap().iter().filter(|t| t["name"] == "task").count(), 1);
    }

    /// A write outside the folder asks in Ask mode even when a rule
    /// allows the tool, offering no "always"; inside the folder the rule applies; Allow mode just writes.
    async fn outside_writes(mode: Mode) -> (tempfile::TempDir, AgentHandle) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("proj")).unwrap();
        let handler: Handler = Arc::new(|req: &Value| {
            if req["messages"].as_array().unwrap().len() == 1 {
                sse(
                    &[
                        json!({"type":"tool_call","id":"in","name":"write","input":{"path":"inside.txt","content":"in"}}),
                        json!({"type":"tool_call","id":"out","name":"write","input":{"path":"../outside.txt","content":"out"}}),
                    ],
                    "tool_use",
                )
            } else {
                sse(&[json!({"type":"text","text":"Done."})], "end_turn")
            }
        });
        let url = mock(handler, Arc::new(StdMutex::new(vec![]))).await;
        let mut cfg = config(&dir.path().join("proj"), mode);
        cfg.rules = vec![Rule::parse("write").unwrap()];
        let h = spawn(ApiClient::new(url, Some("t".into())), cfg);
        h.input.send(AgentInput::User { text: "go".into(), images: vec![] }).unwrap();
        (dir, h)
    }

    #[tokio::test]
    async fn outside_the_folder_asks_in_ask_mode_despite_rules() {
        let (dir, mut h) = outside_writes(Mode::Ask).await;
        let evs = until(&mut h, |e| matches!(e, AgentEvent::PermissionRequest { .. })).await;
        let AgentEvent::PermissionRequest { request_id, title, rule, .. } = evs.last().unwrap().clone() else { unreachable!() };
        assert_eq!((title.as_str(), rule.as_str()), ("../outside.txt", ""), "asked, with no rule to remember");
        assert_eq!(std::fs::read_to_string(dir.path().join("proj/inside.txt")).unwrap(), "in", "the rule covered the inside write");
        assert!(!dir.path().join("outside.txt").exists());
        // "Always" with nothing to remember is just this once.
        h.input.send(AgentInput::PermissionReply { request_id, decision: Decision::Always, message: None }).unwrap();
        until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        assert_eq!(std::fs::read_to_string(dir.path().join("outside.txt")).unwrap(), "out");
        assert!(!dir.path().join("proj/.gond-agent/settings.json").exists(), "no project rule saved");
    }

    #[tokio::test]
    async fn rules_never_cover_the_folders_own_settings() {
        let dir = tempfile::tempdir().unwrap();
        let handler: Handler = Arc::new(|req: &Value| {
            if req["messages"].as_array().unwrap().len() == 1 {
                sse(&[json!({"type":"tool_call","id":"s","name":"write","input":{"path":".gond-agent/settings.json","content":"{\"mode\":\"allow\"}"}})], "tool_use")
            } else {
                sse(&[json!({"type":"text","text":"Done."})], "end_turn")
            }
        });
        let url = mock(handler, Arc::new(StdMutex::new(vec![]))).await;
        let mut cfg = config(dir.path(), Mode::Ask);
        cfg.rules = vec![Rule::parse("write").unwrap()];
        let mut h = spawn(ApiClient::new(url, Some("t".into())), cfg);
        h.input.send(AgentInput::User { text: "go".into(), images: vec![] }).unwrap();
        let evs = until(&mut h, |e| matches!(e, AgentEvent::PermissionRequest { .. })).await;
        let AgentEvent::PermissionRequest { rule, .. } = evs.last().unwrap() else { unreachable!() };
        assert_eq!(rule, "", "asked, with no rule to remember");
        assert!(!dir.path().join(".gond-agent/settings.json").exists());
    }

    #[tokio::test]
    async fn outside_the_folder_is_allowed_in_allow_mode() {
        let (dir, mut h) = outside_writes(Mode::Allow).await;
        let evs = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        assert!(!evs.iter().any(|e| matches!(e, AgentEvent::PermissionRequest { .. })));
        assert_eq!(std::fs::read_to_string(dir.path().join("outside.txt")).unwrap(), "out");
    }

    #[tokio::test]
    async fn autonomous_runs_never_ask() {
        // An autonomous worker configuration: mode allow, non-interactive.
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(StdMutex::new(vec![]));
        let handler: Handler = Arc::new(|req: &Value| {
            if req["messages"].as_array().unwrap().len() == 1 {
                sse(
                    &[
                        json!({"type":"tool_call","id":"q","name":"ask_user","input":{"questions":[{"question":"Which?","options":[{"label":"a"},{"label":"b"}]}]}}),
                        json!({"type":"tool_call","id":"w","name":"write","input":{"path":"x.txt","content":"hi"}}),
                        json!({"type":"tool_call","id":"b","name":"bash","input":{"command":"cat x.txt"}}),
                    ],
                    "tool_use",
                )
            } else {
                sse(&[json!({"type":"text","text":"Done."})], "end_turn")
            }
        });
        let url = mock(handler, seen.clone()).await;
        let mut cfg = config(dir.path(), Mode::Allow);
        cfg.interactive = false;
        let mut h = spawn(ApiClient::new(url, Some("t".into())), cfg);
        h.input.send(AgentInput::User { text: "go".into(), images: vec![] }).unwrap();
        let evs = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        assert!(!evs.iter().any(|e| matches!(e, AgentEvent::PermissionRequest { .. } | AgentEvent::Question { .. })));
        assert_eq!(std::fs::read_to_string(dir.path().join("x.txt")).unwrap(), "hi");
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::ToolEnd { ok: true, output, .. } if output == "hi")));
    }

    #[tokio::test]
    async fn attached_images_reach_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(StdMutex::new(vec![]));
        let handler: Handler = Arc::new(|_: &Value| sse(&[json!({"type":"text","text":"A cat."})], "end_turn"));
        let url = mock(handler, seen.clone()).await;
        let mut h = spawn(ApiClient::new(url, Some("t".into())), config(dir.path(), Mode::Ask));
        let images = vec![
            ImageInput { media_type: "image/png".into(), data: "iVBORw0K".into(), id: None },
            ImageInput { media_type: "image/jpeg".into(), id: Some("img_cloud".into()), ..Default::default() },
        ];
        h.input.send(AgentInput::User { text: "what is [Image #1]?".into(), images }).unwrap();
        until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        let reqs = seen.lock().unwrap();
        let content = &reqs[0]["messages"][0]["content"];
        assert_eq!(content[0], json!({"type": "text", "text": "what is [Image #1]?"}));
        assert_eq!(content[1], json!({"type": "image", "media_type": "image/png", "data": "iVBORw0K"}));
        assert_eq!(content[2], json!({"type": "image", "media_type": "image/jpeg", "id": "img_cloud"}), "uploaded images go by id");
    }

    #[tokio::test]
    async fn completion_requires_review_and_rejects_later_edits() {
        for stale in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            for args in [vec!["init"], vec!["-c","user.name=Test","-c","user.email=test@localhost","commit","--allow-empty","-m","init"]] {
                assert!(tokio::process::Command::new("git").args(args).current_dir(dir.path()).output().await.unwrap().status.success());
            }
            let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let handler: Handler = Arc::new(move |_: &Value| {
                let n = count.fetch_add(1, Ordering::Relaxed);
                let call = match n {
                    0 => json!({"type":"tool_call","id":"w","name":"write","input":{"path":"new.txt","content":"verified"}}),
                    // A premature final answer must not finish the turn.
                    1 => return sse(&[json!({"type":"text","text":"Done too soon"})], "end_turn"),
                    2 => json!({"type":"tool_call","id":"check","name":"bash","input":{"command":"test -f new.txt"}}),
                    3 => json!({"type":"tool_call","id":"diff","name":"bash","input":{"command":"git diff; cat new.txt"}}),
                    4 => json!({"type":"tool_call","id":"review","name":"finish_review","input":{"understanding":"Traced the code","design":"Use the existing pattern","checks":["check"],"diff_call_id":"diff","review":"Reviewed the diff and new file","web_app":false}}),
                    5 if stale => json!({"type":"tool_call","id":"later","name":"write","input":{"path":"later.txt","content":"unverified"}}),
                    _ => return sse(&[json!({"type":"text","text":"Finished"})], "end_turn"),
                };
                sse(&[call], "tool_use")
            });
            let seen = Arc::new(StdMutex::new(vec![]));
            let url = mock(handler, seen.clone()).await;
            let mut cfg = config(dir.path(), Mode::Allow);
            cfg.require_review = true;
            let mut h = spawn(ApiClient::new(url, None), cfg);
            h.input.send(AgentInput::User {text:"Implement it".into(), images:vec![]}).unwrap();
            let events = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd {agent_id, ..} if agent_id == "main")).await;
            assert!(events.iter().any(|e| matches!(e, AgentEvent::ToolEnd {call_id, ok:true, ..} if call_id == "review")));
            assert!(matches!(events.last(), Some(AgentEvent::TurnEnd {stop_reason, ..}) if stop_reason == if stale {"error"} else {"end_turn"}));
            assert!(seen.lock().unwrap().iter().any(|r| r["messages"].as_array().unwrap().iter().any(|m| m["role"] == "user" && m["content"][0]["text"].as_str().is_some_and(|s| s.contains("Completion blocked")))));
        }
    }

    #[tokio::test]
    async fn explicit_verification_blocker_fails_without_successful_turn_end() {
        let dir = tempfile::tempdir().unwrap();
        let url = mock(Arc::new(|_| sse(&[json!({"type":"tool_call","id":"blocker","name":"finish_review","input":{"blocked":true,"limitations":"The required service is unavailable"}})],"tool_use")), Arc::new(StdMutex::new(vec![]))).await;
        let mut cfg = config(dir.path(), Mode::Allow);
        cfg.require_review = true;
        let mut h = spawn(ApiClient::new(url,None),cfg);
        h.input.send(AgentInput::User {text:"Check it".into(),images:vec![]}).unwrap();
        let events = until(&mut h, |e| matches!(e, AgentEvent::Error {..})).await;
        assert!(!events.iter().any(|e| matches!(e, AgentEvent::TurnEnd {stop_reason,..} if stop_reason == "end_turn")));
        assert!(events.iter().any(|e| matches!(e, AgentEvent::Error {message,..} if message.contains("service is unavailable"))));
    }

    #[tokio::test]
    async fn plan_mode_blocks_writes_and_subagents_run_in_parallel() {
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(StdMutex::new(vec![]));
        let handler: Handler = Arc::new(|req: &Value| {
            let agent = req["metadata"]["agent_id"].as_str().unwrap_or("");
            let n = req["messages"].as_array().unwrap().len();
            match (agent, n) {
                ("main", 1) => sse(
                    &[
                        json!({"type":"tool_call","id":"a","name":"task","input":{"description":"find middleware","prompt":"look","kind":"explore"}}),
                        json!({"type":"tool_call","id":"b","name":"task","input":{"description":"run tests","prompt":"test","kind":"general"}}),
                        json!({"type":"tool_call","id":"c","name":"write","input":{"path":"x.txt","content":"no"}}),
                    ],
                    "tool_use",
                ),
                ("main", _) => sse(&[json!({"type":"text","text":"Plan ready."})], "end_turn"),
                (_, _) => sse(&[json!({"type":"text","text":format!("report from {agent}")})], "end_turn"),
            }
        });
        let url = mock(handler, seen.clone()).await;
        let mut h = spawn(ApiClient::new(url, Some("t".into())), config(dir.path(), Mode::Plan));
        h.input.send(AgentInput::User { text: "plan it".into(), images: vec![] }).unwrap();
        let evs = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;

        let spawned: Vec<_> = evs.iter().filter_map(|e| if let AgentEvent::AgentSpawn { agent_id, .. } = e { Some(agent_id.clone()) } else { None }).collect();
        assert_eq!(spawned.len(), 2);
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::ToolEnd { ok: false, summary, .. } if summary == "blocked")), "write blocked in plan mode");
        assert!(!dir.path().join("x.txt").exists());

        let reqs = seen.lock().unwrap();
        let explore = reqs.iter().find(|r| r["metadata"]["agent_id"].as_str().unwrap().starts_with("explore")).unwrap();
        let names: Vec<&str> = explore["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"read") && !names.contains(&"bash") && !names.contains(&"task"), "explore is read-only: {names:?}");
        let last = reqs.iter().rev().find(|r| r["metadata"]["agent_id"] == "main").unwrap();
        let results = &last["messages"][2]["content"];
        assert!(results[0]["content"][0]["text"].as_str().unwrap().starts_with("report from explore"));
        assert_eq!(results[2]["is_error"], true);
    }

    #[tokio::test]
    async fn skill_toggles_apply_to_the_next_request() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join("deploy");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(skill_dir.join("SKILL.md"), "---\nname: deploy\ndescription: Ship the worker\n---\nRun docker compose up.").unwrap();
        let seen = Arc::new(StdMutex::new(vec![]));
        let handler: Handler = Arc::new(|req: &Value| {
            let msgs = req["messages"].as_array().unwrap();
            if msgs.len() == 1 {
                sse(&[json!({"type":"tool_call","id":"k","name":"skill","input":{"name":"deploy"}})], "tool_use")
            } else {
                sse(&[json!({"type":"text","text":"ok"})], "end_turn")
            }
        });
        let url = mock(handler, seen.clone()).await;
        let mut cfg = config(dir.path(), Mode::Ask);
        cfg.skills = vec![Skill { name: "deploy".into(), description: "Ship the worker".into(), dir: skill_dir, enabled: true }];
        let mut h = spawn(ApiClient::new(url, Some("t".into())), cfg);

        h.input.send(AgentInput::User { text: "deploy it".into(), images: vec![] }).unwrap();
        until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        h.input.send(AgentInput::Skill { name: "deploy".into(), enabled: false }).unwrap();
        h.input.send(AgentInput::User { text: "again".into(), images: vec![] }).unwrap();
        until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;

        let reqs = seen.lock().unwrap();
        let has_skill = |r: &Value| r["tools"].as_array().unwrap().iter().any(|t| t["name"] == "skill");
        assert!(has_skill(&reqs[0]) && reqs[0]["system"].as_str().unwrap().contains("- deploy: Ship the worker"));
        let result = &reqs[1]["messages"][2]["content"][0];
        assert!(result["content"][0]["text"].as_str().unwrap().contains("Run docker compose up."), "{result}");
        let last = reqs.last().unwrap();
        assert!(!has_skill(last) && !last["system"].as_str().unwrap().contains("deploy"), "disabled skill gone without a restart");
    }


    #[tokio::test]
    async fn compaction_and_plan_tools() {
        let dir = tempfile::tempdir().unwrap();
        let seen = Arc::new(StdMutex::new(vec![]));
        let handler: Handler = Arc::new(|req: &Value| {
            let msgs = req["messages"].as_array().unwrap();
            let last = msgs.last().unwrap()["content"][0]["text"].as_str().unwrap_or("");
            if last.starts_with("Summarize this conversation") {
                return sse(&[json!({"type":"text","text":"SUMMARY: user wants a plan."})], "end_turn");
            }
            match msgs.len() {
                1 => sse(
                    &[
                        json!({"type":"tool_call","id":"p","name":"update_plan","input":{"plan":[{"step":"read","status":"done"},{"step":"edit","status":"in_progress"}]}}),
                        json!({"type":"tool_call","id":"l","name":"list_plan","input":{}}),
                    ],
                    "tool_use",
                ),
                _ => sse(&[json!({"type":"text","text":"ok"})], "end_turn"),
            }
        });
        let url = mock(handler, seen.clone()).await;
        let mut h = spawn(ApiClient::new(url, Some("t".into())), config(dir.path(), Mode::Ask));
        h.input.send(AgentInput::User { text: "plan it".into(), images: vec![] }).unwrap();
        let evs = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::Todos { items, .. } if items.len() == 2 && items[1].text == "edit")));

        h.input.send(AgentInput::Compact).unwrap();
        let evs = until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        assert!(evs.iter().any(|e| matches!(e, AgentEvent::Compacted { .. })));
        assert!(!evs.iter().any(|e| matches!(e, AgentEvent::TextDelta { agent_id, .. } if agent_id == "main")), "summary stays out of the transcript");

        h.input.send(AgentInput::User { text: "continue".into(), images: vec![] }).unwrap();
        until(&mut h, |e| matches!(e, AgentEvent::TurnEnd { agent_id, .. } if agent_id == "main")).await;
        let reqs = seen.lock().unwrap();
        let listed = reqs[1]["messages"][2]["content"][1]["content"][0]["text"].as_str().unwrap();
        assert_eq!(listed, "1. [done] read\n2. [in_progress] edit");
        let last = reqs.last().unwrap()["messages"].as_array().unwrap();
        assert_eq!(last.len(), 2, "history replaced by the summary + new message");
        assert!(last[0]["content"][0]["text"].as_str().unwrap().contains("SUMMARY: user wants a plan."));
    }



}
