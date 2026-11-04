//! Transparency, not enforcement: evidence recorded by the worker is not
//! independent proof. Same-UID code can inspect process memory. Only a separate
//! container re-run could provide independent proof (outside this ledger).
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::evidence_policy::{CheckCommand, EvidencePolicy};

pub const MAX_RECORDS: usize = 40;
pub const MAX_GATE_ROUNDS: u32 = 6;
pub const MAX_RESUMES: u32 = 10;
type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum EvidenceKind {
    Check,
    UiAttempt { url: String, title: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Record {
    pub seq: u64,
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub started_at: u64,
    pub tree_hash_before: String,
    pub tree_hash_after: String,
    pub tests_ran: Option<u64>,
    pub env_clean: bool,
    pub env_digest: String,
    pub output_tail: String,
    pub kind: EvidenceKind,
    pub sig: String,
}

impl Record {
    fn payload(&self) -> Vec<u8> {
        // serde_json::Value maps sort keys recursively. This is also the API's
        // canonicalization, not struct field order or model-provided JSON.
        let mut value = serde_json::to_value(self).expect("record serializes");
        value.as_object_mut().unwrap().remove("sig");
        serde_json::to_vec(&value).expect("record serializes")
    }

    fn sign(&mut self, key: &[u8]) {
        let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts key");
        mac.update(&self.payload());
        self.sig = hex(&mac.finalize().into_bytes());
    }

    pub fn authentic(&self, key: &[u8]) -> bool {
        let Some(signature) = unhex(&self.sig) else {
            return false;
        };
        let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts key");
        mac.update(&self.payload());
        mac.verify_slice(&signature).is_ok()
    }

    pub fn fresh(&self, tree: &str) -> bool {
        !tree.is_empty() && self.tree_hash_before == tree && self.tree_hash_after == tree
    }

    pub fn successful_check(&self) -> bool {
        self.kind == EvidenceKind::Check
            && self.exit_code == Some(0)
            && self.tests_ran.is_some_and(|count| count > 0)
            && self.env_clean
    }

    pub fn validate(&self) -> bool {
        self.seq > 0
            && uuid::Uuid::parse_str(&self.id).is_ok()
            && self.command.len() <= 4096
            && self.cwd.len() <= 1024
            && relative(&self.cwd)
            && self.output_tail.len() <= 4096
            && oid(&self.tree_hash_before)
            && oid(&self.tree_hash_after)
            && self.env_digest.len() == 64
            && unhex(&self.env_digest).is_some()
            && self.sig.len() == 64
            && unhex(&self.sig).is_some()
            && match &self.kind {
                EvidenceKind::Check => true,
                EvidenceKind::UiAttempt { url, title } => {
                    url.len() <= 2048
                        && title.len() <= 300
                        && (url.starts_with("http://") || url.starts_with("https://"))
                }
            }
    }
}

fn oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn relative(value: &str) -> bool {
    value == "."
        || !value.is_empty()
            && !value.contains(['\\', ':'])
            && value
                .split('/')
                .all(|p| !p.is_empty() && p != "." && p != "..")
            && !value.chars().any(char::is_control)
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(value: &str) -> Option<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
        return None;
    }
    value
        .as_bytes()
        .chunks(2)
        .map(|c| {
            std::str::from_utf8(c)
                .ok()
                .and_then(|c| u8::from_str_radix(c, 16).ok())
        })
        .collect()
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Ledger {
    // Private state-RPC/checkpoint data only. Never emitted in transcript events,
    // put in a child environment, source file, ordinary run row, or logs.
    pub key: Option<String>,
    pub records: Vec<Record>,
    pub policy: EvidencePolicy,
    pub seq: u64,
    pub gate_rounds: u32,
    pub turn_gate_rounds: u32,
    pub resumes: u32,
    pub fix_rounds: u32,
    pub reviews: u32,
    pub unverified: Vec<String>,
    pub stale_ids: Vec<String>,
    #[serde(default)]
    pub historical_ids: Vec<String>,
    pub declared: bool,
    pub turn_tree: Option<String>,
}

impl std::fmt::Debug for Ledger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Assertion failures and error diagnostics must not expose private state.
        f.debug_struct("Ledger")
            .field("key", &"[redacted]")
            .field("record_count", &self.records.len())
            .field("seq", &self.seq)
            .field("gate_rounds", &self.gate_rounds)
            .field("resumes", &self.resumes)
            .finish_non_exhaustive()
    }
}

impl Ledger {
    pub fn new(cwd: &Path) -> Self {
        let seed = |name: &str| {
            std::env::var(name)
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
        };
        Self {
            key: Some(format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )),
            records: vec![],
            policy: super::evidence_policy::discover(cwd),
            seq: seed("GOND_AGENT_EVIDENCE_SEQ"),
            gate_rounds: seed("GOND_AGENT_EVIDENCE_GATE_ROUNDS").min(MAX_GATE_ROUNDS as u64) as u32,
            turn_gate_rounds: 0,
            resumes: seed("GOND_AGENT_EVIDENCE_RESUMES").min(MAX_RESUMES as u64) as u32,
            fix_rounds: 0,
            reviews: 0,
            unverified: vec![],
            stale_ids: vec![],
            historical_ids: vec![],
            declared: false,
            turn_tree: None,
        }
    }

    pub fn begin_turn(&mut self, tree: Option<String>, resumed: bool) {
        if !resumed {
            self.turn_gate_rounds = 0;
            self.declared = false;
            self.unverified.clear();
            self.turn_tree = tree;
        }
    }

    pub fn check<'a>(&'a self, name: &str, input: &serde_json::Value) -> Option<&'a CheckCommand> {
        if name != "run_checks" || input["run_in_background"] == true {
            return None;
        }
        let command = input["command"].as_str()?;
        let cwd = input.get("cwd").and_then(|v| v.as_str()).unwrap_or(".");
        self.policy
            .checks
            .iter()
            .find(|c| c.command == command && c.cwd == cwd)
    }

    pub fn record(&mut self, mut record: Record) -> Option<Record> {
        self.seq = self.seq.checked_add(1)?;
        record.seq = self.seq;
        record.id = uuid::Uuid::new_v4().to_string();
        record.output_tail = scrub(&record.output_tail, 4096);
        record.sign(&unhex(self.key.as_ref()?)?);
        if !record.validate() {
            return None;
        }
        if self.records.len() == MAX_RECORDS {
            let removed = self.records.remove(0);
            self.stale_ids.retain(|id| id != &removed.id);
            self.historical_ids.retain(|id| id != &removed.id);
        }
        self.records.push(record.clone());
        Some(record)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if self.records.len() > MAX_RECORDS
            || self.stale_ids.len() > MAX_RECORDS
            || self.historical_ids.len() > MAX_RECORDS
            || self.unverified.len() > 32
            || self.unverified.iter().any(|s| s.len() > 1000)
            || self.gate_rounds > MAX_GATE_ROUNDS
            || self.turn_gate_rounds > 2
            || self.resumes > MAX_RESUMES
            || self.fix_rounds > 10
            || self.reviews > 10
            || self.policy.checks.len() > 128
            || self.policy.notes.len() > 32
            || self.policy.notes.iter().any(|n| n.len() > 1000)
            || self.policy.source.len() > 2048
            || self
                .policy
                .checks
                .iter()
                .any(|c| c.command.len() > 4096 || !relative(&c.cwd))
        {
            return Err("invalid_evidence_bounds");
        }
        let key = match &self.key {
            Some(k) => Some(
                unhex(k)
                    .filter(|k| k.len() == 32)
                    .ok_or("invalid_evidence_key")?,
            ),
            None => None,
        };
        let mut last = 0;
        let mut ids = HashSet::new();
        for record in &self.records {
            if !record.validate()
                || record.seq <= last
                || record.seq > self.seq
                || !ids.insert(&record.id)
                || key.as_ref().is_some_and(|k| {
                    !self.historical_ids.contains(&record.id) && !record.authentic(k)
                })
            {
                return Err("invalid_evidence_record");
            }
            last = record.seq;
        }
        if self.stale_ids.iter().any(|id| !ids.contains(id)) {
            return Err("invalid_evidence_staleness");
        }
        if self
            .historical_ids
            .iter()
            .any(|id| !ids.contains(id) || !self.stale_ids.contains(id))
        {
            return Err("invalid_evidence_history");
        }
        Ok(())
    }

    pub fn restore(&mut self, tree: Option<&str>) {
        self.resumes = self.resumes.saturating_add(1).min(MAX_RESUMES);
        let missing_key = self.key.is_none();
        for record in &self.records {
            if (missing_key || !tree.is_some_and(|t| record.fresh(t)))
                && !self.stale_ids.contains(&record.id)
            {
                self.stale_ids.push(record.id.clone());
            }
        }
        if missing_key {
            self.historical_ids = self.records.iter().map(|r| r.id.clone()).collect();
            self.note("Evidence recorded before restart cannot satisfy the gate; re-run a check.");
            self.key = Some(format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ));
            // Historical signatures belong to an unavailable key. Keep them as
            // historical state but never re-sign them or accept them as fresh.
        }
        self.note("Ignored files such as node_modules may be absent after restore.");
    }

    pub fn declare(&mut self, reason: &str) {
        self.declared = true;
        let reason = scrub(reason, 1000);
        self.note(&format!(
            "Declared unverified: {}",
            if reason.trim().is_empty() {
                "No reason supplied"
            } else {
                &reason
            }
        ));
    }

    fn note(&mut self, value: &str) {
        if self.unverified.len() < 32 && !self.unverified.iter().any(|s| s == value) {
            self.unverified.push(scrub(value, 1000));
        }
    }

    pub fn gate(&mut self, cwd: &Path, tree: Option<&str>) -> Option<String> {
        if !self.policy.enabled || self.declared {
            return None;
        }
        if !cwd.join(".git").exists() {
            self.note("No repository tree is available; no execution evidence covers publication.");
            return None;
        }
        // A no-change follow-up never consumes a gate round. A missing hash
        // fails closed rather than silently claiming that nothing changed.
        if tree.is_some() && tree == self.turn_tree.as_deref() {
            return None;
        }
        let requirements = tree.and_then(|t| self.policy.requirements(cwd, t).ok());
        let docs_only = requirements.as_ref().is_some_and(|r| r.docs_only);
        if docs_only {
            self.note("Docs-only change: the check requirement is waived.");
        }
        if requirements.as_ref().is_some_and(|r| !r.changed) {
            return None;
        }
        let fresh =
            |r: &&Record| tree.is_some_and(|t| r.fresh(t)) && !self.stale_ids.contains(&r.id);
        // The docs waiver never upgrades a stale record: if a check was
        // attempted on another tree, re-run it even for a docs-only delta.
        let stale_check = self
            .records
            .iter()
            .any(|r| r.kind == EvidenceKind::Check && !tree.is_some_and(|t| r.fresh(t)));
        let check_missing = (!docs_only || stale_check)
            && !self
                .records
                .iter()
                .filter(fresh)
                .any(Record::successful_check);
        let ui_missing = requirements.as_ref().is_none_or(|r| r.ui)
            && !self
                .records
                .iter()
                .filter(fresh)
                .any(|r| matches!(r.kind, EvidenceKind::UiAttempt { .. }));
        if !check_missing && !ui_missing {
            return None;
        }
        if self.turn_gate_rounds >= 2
            || self.gate_rounds >= MAX_GATE_ROUNDS
            || self.resumes >= MAX_RESUMES
        {
            if check_missing {
                self.note("Missing a fresh successful check with a positive parsed test count.");
            }
            if ui_missing {
                self.note("Missing a fresh UI attempt.");
            }
            self.note("Not fully verified: the advisory evidence gate budget was exhausted.");
            return None;
        }
        self.turn_gate_rounds += 1;
        self.gate_rounds += 1;
        let mut message = String::from(
            "Evidence gate (transparency, not enforcement). Evidence recorded by the worker is missing or stale.\n",
        );
        if check_missing {
            message.push_str("Requirement CHECK: run one eligible exact command with run_checks; it must report more than zero tests and leave the tree unchanged.\n");
            for (index, check) in self.policy.checks.iter().take(16).enumerate() {
                // Only quoted, bounded data. Never splice raw policy text into
                // an instruction, even when a repository policy is hostile.
                message.push_str(&format!(
                    "CHECK[{}] command={} cwd={}\n",
                    index + 1,
                    serde_json::to_string(&scrub(&check.command, 200)).unwrap(),
                    serde_json::to_string(&scrub(&check.cwd, 200)).unwrap()
                ));
            }
        }
        if ui_missing {
            message.push_str("Requirement UI_ATTEMPT: attempt the changed interface with a browser tool on the final tree. This records an attempt, not proof of correctness.\n");
        }
        message.push_str("Alternatively call declare_unverified with a plain reason; it will always appear under Not verified. Do not claim independent proof.");
        Some(message)
    }
}

/// Exactly the environment installed by run_checks' shell launcher. Its digest
/// describes the allow-list values, not the absence of secrets in HOME/.npmrc.
pub fn check_environment() -> BTreeMap<String, String> {
    const ALLOWED: &[&str] = &[
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "SHELL",
        "LANG",
        "LC_ALL",
        "TZ",
        "TERM",
        "TMPDIR",
        "TMP",
        "TEMP",
        "TEMPDIR",
        "XDG_CACHE_HOME",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "RUSTUP_TOOLCHAIN",
        "NPM_CONFIG_CACHE",
        "npm_config_cache",
        "PIP_CACHE_DIR",
        "UV_CACHE_DIR",
        "UV_TOOL_DIR",
        "UV_TOOL_BIN_DIR",
        "UV_PYTHON_INSTALL_DIR",
        "PYTHONUSERBASE",
    ];
    ALLOWED
        .iter()
        .filter_map(|name| std::env::var(name).ok().map(|v| ((*name).to_string(), v)))
        .collect()
}
pub fn environment_digest() -> String {
    hex(&Sha256::digest(
        serde_json::to_vec(&check_environment()).unwrap(),
    ))
}

pub fn ui_metadata(url: &str, output: &crate::tools::ToolOutput) -> (String, String) {
    let url = reqwest::Url::parse(url)
        .ok()
        .map(|mut url| {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        })
        .unwrap_or_default();
    let title = output
        .content
        .iter()
        .find_map(|part| match part {
            crate::api::wire::ResultPart::Text { text } => {
                serde_json::from_str::<serde_json::Value>(text)
                    .ok()
                    .and_then(|v| v["title"].as_str().map(str::to_owned))
                    .or_else(|| {
                        text.lines()
                            .find_map(|line| line.strip_prefix("Title: ").map(str::to_owned))
                    })
            }
            _ => None,
        })
        .unwrap_or_default();
    (url, scrub(&title, 300))
}

pub fn tests_ran(text: &str) -> Option<u64> {
    // Prefer summaries, not individual test lines (which can be truncated or
    // duplicated). Sum Cargo's per-binary summaries, parse other runners once.
    let text = Regex::new(r"\x1b\[[0-9;]*[A-Za-z]")
        .unwrap()
        .replace_all(text, "");
    let cargo = Regex::new(r"test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;").unwrap();
    let counts: Vec<u64> = cargo
        .captures_iter(&text)
        .filter_map(|c| Some(c[1].parse::<u64>().ok()? + c[2].parse::<u64>().ok()?))
        .collect();
    if !counts.is_empty() {
        return Some(counts.iter().sum());
    }
    let node = Regex::new(r"(?m)^(?:#|ℹ) (?:pass|fail) (\d+)\s*$").unwrap();
    let counts: Vec<u64> = node
        .captures_iter(&text)
        .filter_map(|c| c[1].parse().ok())
        .collect();
    if !counts.is_empty() {
        return Some(counts.iter().sum());
    }
    if let Some(line) = text
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with("Tests"))
    {
        let outcomes = Regex::new(r"(\d+) (passed|failed|skipped|todo|pending)").unwrap();
        let counts: Vec<_> = outcomes.captures_iter(line).collect();
        if !counts.is_empty() {
            return Some(
                counts
                    .iter()
                    .filter(|c| matches!(&c[2], "passed" | "failed"))
                    .filter_map(|c| c[1].parse::<u64>().ok())
                    .sum(),
            );
        }
    }
    for pattern in [r"(?m)^(?:#|ℹ) tests (\d+)\s*$", r"(?m)^\s*(\d+) passing\b"] {
        if let Some(c) = Regex::new(pattern).unwrap().captures(&text) {
            return c[1].parse().ok();
        }
    }
    // pytest summaries can have passed and failed counts on the same line.
    if let Some(line) = text.lines().rev().find(|l| {
        (l.contains(" passed") || l.contains(" failed") || l.contains("no tests ran"))
            && (l.contains(" in ") || l.contains("no tests ran"))
    }) {
        if line.contains("no tests ran") {
            return Some(0);
        }
        let re = Regex::new(r"(\d+) (?:passed|failed|error(?:s)?)\b").unwrap();
        let values: Vec<u64> = re
            .captures_iter(line)
            .filter_map(|c| c[1].parse().ok())
            .collect();
        if !values.is_empty() {
            return Some(values.iter().sum());
        }
    }
    if text.contains("No tests found") || text.contains("No test files found") {
        return Some(0);
    }
    None
}

/// Same secret patterns as the service's CI-log scrubber, applied BEFORE byte
/// truncation. Text is untrusted even after scrubbing; this is not a secrets scan.
pub fn scrub(text: &str, limit: usize) -> String {
    let mut text = Regex::new(r"\x1b\[[0-9;]*[A-Za-z]")
        .unwrap()
        .replace_all(text, "")
        .into_owned();
    for pattern in [
        r#"https?://[^\s<>\"']+"#,
        r"(?s)-----BEGIN [^-\r\n]*PRIVATE KEY-----.*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)",
        r"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16}|npm_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b",
    ] {
        text = Regex::new(pattern)
            .unwrap()
            .replace_all(&text, "[redacted]")
            .into_owned();
    }
    text = Regex::new(r#"(?i)\b(bearer|basic)\s+[^\s,;\"']+"#)
        .unwrap()
        .replace_all(&text, "$1 [redacted]")
        .into_owned();
    text = Regex::new(r#"(?i)([\"']?(?:password|passwd|token|secret|credential|authorization|api[ _-]?key|access[_-]?token|(?:github|gh|openai)[_-]?(?:token|api[_-]?key)|(?:aws[_-]?)?secret[_-]?access[_-]?key|client[_-]?secret)[\"']?\s*[:=]\s*)(?:\"[^\"\r\n]*\"|'[^'\r\n]*'|[^\s,;]+)"#).unwrap().replace_all(&text, "$1[redacted]").into_owned();
    text.retain(|c| (!c.is_control() || c == '\n' || c == '\t') && !invisible(c));
    let mut start = text.len().saturating_sub(limit);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

pub fn invisible(c: char) -> bool {
    matches!(c as u32, 0x00ad | 0x061c | 0x06dd | 0x070f | 0x08e2 | 0x180e | 0xfeff | 0x110bd | 0x110cd | 0xe0001
        | 0x0600..=0x0605 | 0x0890..=0x0891 | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x206f
        | 0xfff9..=0xfffb | 0x13430..=0x1343f | 0x1bca0..=0x1bca3 | 0x1d173..=0x1d17a | 0xe0020..=0xe007f | 0xfe00..=0xfe0f | 0xe0100..=0xe01ef)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Record {
        Record {
            seq: 0,
            id: String::new(),
            command: "npm test".into(),
            cwd: ".".into(),
            exit_code: Some(0),
            duration_ms: 10,
            started_at: 1,
            tree_hash_before: "a".repeat(40),
            tree_hash_after: "a".repeat(40),
            tests_ran: Some(2),
            env_clean: true,
            env_digest: "b".repeat(64),
            output_tail: "test passed".into(),
            kind: EvidenceKind::Check,
            sig: String::new(),
        }
    }
    #[test]
    fn signatures_replay_order_eviction_and_staleness() {
        let dir = tempfile::tempdir().unwrap();
        let mut ledger = Ledger::new(dir.path());
        let r = ledger.record(record()).unwrap();
        assert!(ledger.validate().is_ok());
        assert!(r.authentic(&unhex(ledger.key.as_ref().unwrap()).unwrap()));
        let mut forged = r.clone();
        forged.exit_code = Some(9);
        assert!(!forged.authentic(&unhex(ledger.key.as_ref().unwrap()).unwrap()));
        assert!(!r.authentic(&[0; 32]));
        assert!(r.fresh(&"a".repeat(40)));
        assert!(!r.fresh(&"c".repeat(40)));
        forged.tree_hash_before = "c".repeat(40);
        assert!(!forged.fresh(&"a".repeat(40)));
        let mut duplicate = ledger.clone();
        duplicate.records.push(r.clone());
        assert_eq!(duplicate.validate(), Err("invalid_evidence_record"));
        for _ in 0..MAX_RECORDS {
            ledger.record(record()).unwrap();
        }
        assert_eq!(ledger.records.len(), MAX_RECORDS);
        assert_eq!(ledger.records[0].seq, 2);
        ledger.records.swap(0, 1);
        assert_eq!(ledger.validate(), Err("invalid_evidence_record"));
    }
    #[test]
    fn exact_commands_and_zero_tests() {
        let dir = tempfile::tempdir().unwrap();
        let mut l = Ledger::new(dir.path());
        l.policy.checks = vec![CheckCommand {
            command: "npm test".into(),
            cwd: ".".into(),
        }];
        for (tool, command) in [
            ("bash", "npm test"),
            ("bash", "npm test || true"),
            ("run_checks", "npm test -- --passWithNoTests"),
            ("run_checks", "npm test -- filter"),
        ] {
            assert!(
                l.check(tool, &serde_json::json!({"command": command}))
                    .is_none()
            );
        }
        assert!(
            l.check("run_checks", &serde_json::json!({"command":"npm test"}))
                .is_some()
        );
        let mut r = record();
        r.tests_ran = Some(0);
        assert!(!r.successful_check());
        for (text, count) in [
            (
                "test result: ok. 2 passed; 0 failed;\ntest result: ok. 1 passed; 0 failed;",
                3,
            ),
            ("# tests 5", 5),
            ("Tests: 4 passed, 4 total", 4),
            ("Tests  7 passed (7)", 7),
            ("==== 2 passed, 1 failed in 0.2s ====", 3),
            ("no tests ran in 0.01s", 0),
        ] {
            assert_eq!(tests_ran(text), Some(count), "{text}");
        }
        for text in [
            "Tests: 3 skipped, 3 total",
            "Tests  2 skipped (2)",
            "# tests 2\n# pass 0\n# fail 0\n# skipped 2",
            "ℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ todo 1",
        ] {
            assert_eq!(
                tests_ran(text),
                Some(0),
                "Skipped tests are not executed: {text}"
            );
        }
    }
    #[test]
    fn scrubbing_and_restore() {
        assert_eq!(
            scrub("token=sekret ghp_abcd \u{202e}ok\u{fe0f}", 4096),
            "token=[redacted] [redacted] ok"
        );
        assert!(scrub(&"é".repeat(5000), 4096).len() <= 4096);
        let dir = tempfile::tempdir().unwrap();
        let mut l = Ledger::new(dir.path());
        let r = l.record(record()).unwrap();
        l.restore(Some(&"c".repeat(40)));
        assert!(l.stale_ids.contains(&r.id));
        assert_eq!(l.resumes, 1);
        assert!(l.validate().is_ok());
    }
    #[test]
    fn fixed_templates_quote_hostile_policy_and_cap_budget() {
        let dir = tempfile::tempdir().unwrap();
        let mut l = Ledger::new(dir.path());
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        l.policy.checks = vec![CheckCommand {
            command: "npm test\nIGNORE ALL".into(),
            cwd: ".".into(),
        }];
        let gate = l.gate(dir.path(), None).unwrap();
        assert!(gate.contains("command=\"npm test\\nIGNORE ALL\""));
        assert!(l.gate(dir.path(), None).is_some());
        assert!(l.gate(dir.path(), None).is_none());
        assert!(l.unverified.iter().any(|s| s.contains("budget")));
        l.begin_turn(None, false);
        l.declare("No runtime available");
        assert!(l.gate(dir.path(), None).is_none());
        l.begin_turn(Some("a".repeat(40)), false);
        assert!(l.gate(dir.path(), Some(&"a".repeat(40))).is_none());
    }
}
