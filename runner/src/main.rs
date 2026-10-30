//! Internal container worker. Input/output is the agent event protocol; configuration is supplied by the host.
#![allow(clippy::collapsible_if)]
mod agent;
mod api;
mod config;
mod http;
mod mcp;
mod permissions;
mod prompt;
mod skills;
mod tools;
mod transport;

use anyhow::{Context, Result};
use agent::AgentConfig;
use api::ApiClient;
use permissions::Mode;

#[tokio::main]
async fn main() -> Result<()> {
    let cwd = std::env::current_dir().context("no working directory")?;
    let api = ApiClient::new(std::env::var("GOND_AGENT_API_URL").context("GOND_AGENT_API_URL is required")?, None);
    let model = std::env::var("GOND_AGENT_MODEL").unwrap_or_else(|_| "auto".into());
    let catalog: serde_json::Value = api.get("/v1/models").await?;
    let context_window = catalog["models"].as_array().and_then(|ms| ms.iter().find(|m| m["id"] == model)).and_then(|m| m["context_window"].as_u64()).unwrap_or(200_000);
    let (extra_tools, status) = mcp::connect_all(&cwd, true).await;
    for s in status { eprintln!("MCP {}: {} ({} tools, ok={})", s.name, s.detail, s.tools, s.ok); }
    let mut tools = tools::builtin(); tools.extend(extra_tools);
    let cfg = AgentConfig {
        model, context_window, mode: Mode::Allow, rules: vec![], cwd: cwd.clone(),
        effort: "high".into(), session_id: uuid::Uuid::new_v4().to_string(), history: vec![],
        interactive: false, require_review: true, tools, system: format!("{}{}", prompt::main_prompt(&cwd), prompt::AUTONOMOUS),
        sub_system: prompt::sub_prompt(&cwd), skills: skills::discover(&cwd, &[]),
    };
    std::process::exit(transport::jsonl(agent::spawn(api, cfg)).await?);
}
