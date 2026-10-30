//! One way to build HTTP clients: Gond Agent's user agent and a connect timeout on every connection.

use std::time::Duration;

pub const USER_AGENT: &str = concat!("gond-agent/", env!("CARGO_PKG_VERSION"));

/// A client builder with the user agent and a 10 s connect timeout; callers add their own total timeout.
pub fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).user_agent(USER_AGENT)
}
