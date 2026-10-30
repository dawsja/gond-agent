//! Worker-local MCP access to Gond tools and its existing completion gate.
use anyhow::Result;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use crate::{agent::completion::{self, Completion, Evidence}, tools::{self, ToolCtx}};
fn context() -> ToolCtx {
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    ToolCtx { cwd: std::env::current_dir().unwrap(), agent_id:"main".into(), call_id:String::new(), events,
      reads:Arc::new(Mutex::new(Default::default())), shells:Arc::new(Mutex::new(Default::default())), baseline:Arc::new(Mutex::new(Default::default())), cancel:Default::default() }
}
pub async fn check() -> Result<()> {
    let approved = tokio::fs::read_to_string("/tmp/gond-reviewed").await?;
    anyhow::ensure!(completion::fingerprint(&context()).await.as_deref() == Some(approved.trim()), "Verification and self-review are incomplete");
    Ok(())
}
pub async fn serve() -> Result<()> {
    let tools = tools::builtin();
    let mut ctx = context();
    let mut gate = Completion::default();
    let mut turn = String::new();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let req: Value = serde_json::from_str(&line)?;
        let Some(id) = req.get("id") else { continue };
        let current = tokio::fs::read_to_string("/tmp/gond-turn").await.unwrap_or_default();
        if current != turn { turn = current; gate = Completion {web_app:completion::is_web_app(&ctx.cwd), ..Default::default()}; }
        for evidence in gate.evidence.values_mut() { evidence.observed = true; }
        let result = match req["method"].as_str().unwrap_or("") {
            "initialize" => json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"gond-agent","version":"1"}}),
            "tools/list" => {
                let mut definitions: Vec<Value> = tools.iter().map(|t| json!({"name":t.name(),"description":t.description(),"inputSchema":t.schema()})).collect();
                let d = completion::definition();
                definitions.push(json!({"name":d.name,"description":d.description,"inputSchema":d.input_schema}));
                json!({"tools":definitions})
            },
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let input = req["params"]["arguments"].clone();
                ctx.call_id = id.to_string();
                if name == "finish_review" {
                    let verdict = if input["blocked"] == true { Err("Verification is blocked; explain the limitation to the user") }
                      else if let Some(hash) = completion::fingerprint(&ctx).await { gate.review(&input,&hash) }
                      else { Err("Could not inspect the current worktree") };
                    if verdict.is_ok() { tokio::fs::write("/tmp/gond-reviewed",gate.approved.as_ref().unwrap()).await?; }
                    json!({"content":[{"type":"text","text":verdict.err().unwrap_or("Self-review recorded")}],"isError":verdict.is_err()})
                } else if let Some(tool) = tools.iter().find(|t| t.name() == name) {
                    let diff = name == "bash" && input["command"].as_str().is_some_and(|c| c.contains("git") && c.contains("diff") && !c.contains("--check"));
                    let foreground = input["run_in_background"] != true;
                    let out = tool.run(&ctx,input).await;
                    if out.ok && (name == "browser" || (name == "bash" && foreground)) {
                        if let Some(hash) = completion::fingerprint(&ctx).await { gate.evidence.insert(ctx.call_id.clone(),Evidence {fingerprint:hash,observed:false,browser:name=="browser",diff}); }
                    }
                    let mut content = vec![json!({"type":"text","text":format!("Gond call ID: {}\n{}",ctx.call_id,out.display)})];
                    for part in out.content { if let crate::api::wire::ResultPart::Image{media_type,data} = part {content.push(json!({"type":"image","mimeType":media_type,"data":data}));} }
                    json!({"content":content,"isError":!out.ok})
                } else {json!({"content":[{"type":"text","text":"Unknown tool"}],"isError":true})}
            },
            _ => json!({}),
        };
        stdout.write_all(format!("{}\n",json!({"jsonrpc":"2.0","id":id,"result":result})).as_bytes()).await?;
        stdout.flush().await?;
    }
    Ok(())
}
