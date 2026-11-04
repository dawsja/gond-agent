//! Ephemeral per-container state. No user credentials are stored here.
use std::path::PathBuf;
/// Local relay credential: never inherit into workspace subprocesses or expand in MCP config.
pub const RELAY_TOKEN_ENV: &str = "GOND_AGENT_RELAY_TOKEN";

pub fn home() -> PathBuf {
    std::env::var_os("GOND_AGENT_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp/gond-agent"))
}
