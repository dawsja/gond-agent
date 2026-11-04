//! Internal container worker. Input/output is the agent event protocol; configuration is supplied by the host.
#![allow(clippy::collapsible_if)]
mod agent;
mod api;
mod config;
mod http;
mod images;
mod mcp;
mod permissions;
mod prompt;
mod skills;
mod tools;
mod transport;
#[cfg(test)]
mod relay_security_tests;

use anyhow::{Context, Result};
use agent::AgentConfig;
use api::ApiClient;
use permissions::Mode;

#[tokio::main]
async fn main() -> Result<()> {
    let cwd = std::env::current_dir().context("no working directory")?;
    let token = std::env::var(config::RELAY_TOKEN_ENV).ok().filter(|t| !t.is_empty()).context("Local relay authentication is required")?;
    let api = ApiClient::new(std::env::var("GOND_AGENT_API_URL").context("GOND_AGENT_API_URL is required")?, Some(token));
    let model = std::env::var("GOND_AGENT_MODEL").unwrap_or_else(|_| "auto".into());
    let catalog: serde_json::Value = api.get("/v1/models").await?;
    let context_window = catalog["models"].as_array().and_then(|ms| ms.iter().find(|m| m["id"] == model)).and_then(|m| m["context_window"].as_u64()).unwrap_or(200_000);
    let (extra_tools, status) = mcp::connect_all(&cwd, true).await;
    for s in status { eprintln!("MCP {}: {} ({} tools, ok={})", s.name, s.detail, s.tools, s.ok); }
    let mut tools = tools::builtin(); tools.extend(extra_tools);
    let search_available = catalog["web_search"].as_bool() == Some(true);
    if catalog["web_search"].as_bool() == Some(true) {
        tools.push(tools::bounded(std::sync::Arc::new(tools::web_search::WebSearch { api: api.clone() })));
    } else {
        eprintln!("web_search is unavailable: configure a provider in Settings > Web search. No fallback is used.");
    }
    let cfg = AgentConfig {
        model, context_window, mode: Mode::Allow, rules: vec![], cwd: cwd.clone(),
        effort: std::env::var("GOND_AGENT_EFFORT").unwrap_or_else(|_| "high".into()), session_id: uuid::Uuid::new_v4().to_string(), history: vec![],
        plan: initial_plan(&std::env::var("GOND_AGENT_INITIAL_PLAN").unwrap_or_else(|_| "[]".into())),
        plan_reminder_every: plan_setting("GOND_AGENT_PLAN_REMINDER_EVERY", 6),
        plan_nudge_limit: plan_setting("GOND_AGENT_PLAN_NUDGE_LIMIT", 2).min(2),
        question_wait: std::time::Duration::from_secs(u64::from(plan_setting("GOND_AGENT_QUESTION_WAIT_MINUTES", 240)) * 60),
        interactive: std::env::var("GOND_AGENT_INTERACTIVE").as_deref() == Ok("true"), tools, system: format!("{}{}{}", prompt::main_prompt(&cwd), prompt::AUTONOMOUS, if search_available { "" } else { "\nweb_search is unavailable because no search provider is configured. An administrator can enable it in Settings > Web search. No fallback is used." }),
        sub_system: prompt::sub_prompt(&cwd), skills: skills::discover(&cwd, &[]),
    };
    std::process::exit(transport::jsonl(agent::spawn(api, cfg)).await?);
}

fn plan_setting(name: &str, default: u32) -> u32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn initial_plan(value: &str) -> Vec<agent::events::TodoItem> {
    serde_json::from_str(value).unwrap_or_else(|_| {
        eprintln!("Invalid initial plan; continuing without a plan.");
        vec![]
    })
}
