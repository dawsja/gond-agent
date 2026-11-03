//! Worker-local MCP access to optional workspace tools.
use anyhow::Result;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use crate::tools::{self, ToolCtx};
fn context() -> ToolCtx {
    let (events, _) = tokio::sync::mpsc::unbounded_channel();
    ToolCtx { cwd: std::env::current_dir().unwrap(), agent_id:"main".into(), call_id:String::new(), events,
      reads:Arc::new(Mutex::new(Default::default())), shells:Arc::new(Mutex::new(Default::default())), baseline:Arc::new(Mutex::new(Default::default())), cancel:Default::default() }
}
pub async fn serve() -> Result<()> {
    let tools = tools::builtin();
    let mut ctx = context();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let req: Value = serde_json::from_str(&line)?;
        let Some(id) = req.get("id") else { continue };
        let result = match req["method"].as_str().unwrap_or("") {
            "initialize" => json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"gond-agent","version":"1"}}),
            "tools/list" => {
                let definitions: Vec<Value> = tools.iter().map(|t| json!({"name":t.name(),"description":t.description(),"inputSchema":t.schema()})).collect();
                json!({"tools":definitions})
            },
            "tools/call" => {
                let name = req["params"]["name"].as_str().unwrap_or("");
                let input = req["params"]["arguments"].clone();
                ctx.call_id = id.to_string();
                if let Some(tool) = tools.iter().find(|t| t.name() == name) {
                    let out = tool.run(&ctx,input).await;
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
