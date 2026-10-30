//! Ephemeral per-container state. No user credentials are stored here.
use std::path::PathBuf;
pub fn home() -> PathBuf {
    std::env::var_os("GOND_AGENT_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp/gond-agent"))
}
