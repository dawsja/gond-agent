//! Bounded regression ordering. This is worker-recorded transparency, not proof.
use super::{evidence, evidence_policy::EvidencePolicy, evidence_tree};
use anyhow::{Result, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;

pub const CHEAP_MS: u64 = 120_000;

/// Pure naming policy, shared with Python. Do not confuse it with write safety:
/// an unsafe test link must not become affirmative evidence of a non-test fix.
pub fn test_name(path: &str) -> bool {
    static PATTERNS: std::sync::LazyLock<regex::RegexSet> = std::sync::LazyLock::new(|| {
        let patterns: Vec<String> = serde_json::from_str(include_str!("../../repro-test-paths.json")).unwrap();
        regex::RegexSet::new(patterns).unwrap()
    });
    safe_path(path) && path.split('/').all(|p| !matches!(p.trim_end_matches('.').to_ascii_lowercase().as_str(), ".git" | ".gond-agent"))
        && PATTERNS.is_match(path)
}

/// Packaged once for Rust and the Python controller; never loaded from a run's checkout.
pub fn test_path(root: &Path, path: &str) -> bool {
    test_name(path) && super::subagents::checked_test_path(root, path, |p| p.to_str().is_some_and(test_name))
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Bug,
    Feature,
    Refactor,
    Other,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    NoCheapTestPath,
    NeedsExternalService,
    UiOnly,
    CannotReproduceLocally,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TaskDeclaration {
    pub kind: TaskKind,
    pub repro_plan: String,
    pub skip: Option<SkipReason>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Runner {
    pub runner: String,
    pub cwd: String,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub repro: Phase,
    pub test_files: Vec<String>,
    #[serde(default = "root")]
    pub cwd: String,
}
fn root() -> String {
    ".".into()
}
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Red,
    Green,
}
#[derive(Debug)]
pub struct Prepared {
    pub request: Request,
    pub runner: String,
    pub command: String,
    pub fingerprint: String,
    pub tree: String,
    pub report: Option<std::path::PathBuf>,
}
fn safe_path(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 512
        && !s.starts_with(['/', '-'])
        && s.split('/').all(|p| !p.is_empty() && p != "." && p != "..")
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
}
pub fn prepare(root: &Path, policy: &EvidencePolicy, input: &Value) -> Result<Prepared> {
    let mut req: Request = serde_json::from_value(input.clone())?;
    ensure!(
        !req.test_files.is_empty() && req.test_files.len() <= 32,
        "Supply 1..32 changed test files"
    );
    ensure!(
        req.cwd == "." || safe_path(&req.cwd),
        "Invalid repro directory"
    );
    req.test_files.sort();
    req.test_files.dedup();
    ensure!(
        req.test_files
            .iter()
            .all(|p| test_path(root, p)),
        "Only allow-listed changed test files can be reproduced"
    );
    let runner = policy
        .repro_runners
        .iter()
        .find(|r| r.cwd == req.cwd)
        .ok_or_else(|| anyhow::anyhow!("Unsupported runner; use skip_repro(no_cheap_test_path)"))?
        .runner
        .clone();
    ensure!(
        !policy.repro_definition_changed(
            root,
            &Runner {
                runner: runner.clone(),
                cwd: req.cwd.clone()
            }
        )?,
        "Repro command definition differs from pinned base"
    );
    let snapshot = evidence_tree::repro_snapshot(root, &policy.base, &req.test_files)?;
    ensure!(
        req.repro != Phase::Red || snapshot.non_test_equal,
        "Red refused: non-test tree differs from pinned base"
    );
    let prefix = if req.cwd == "." {
        String::new()
    } else {
        format!("{}/", req.cwd)
    };
    let paths = req
        .test_files
        .iter()
        .map(|p| {
            p.strip_prefix(&prefix)
                .filter(|p| safe_path(p))
                .ok_or_else(|| anyhow::anyhow!("Test file must be inside runner cwd"))
        })
        .collect::<Result<Vec<_>>>()?;
    let report = (runner == "pytest")
        .then(|| std::path::PathBuf::from(format!("/tmp/gond-repro-{}.xml", uuid::Uuid::new_v4())));
    let args = paths.join(" ");
    let command = match runner.as_str() {
        "vitest" => format!("npm test -- --reporter=json {args}"),
        "jest" => format!("npm test -- --json --runInBand --runTestsByPath {args}"),
        "pytest" => format!(
            "pytest --junitxml={} {args}",
            report.as_ref().unwrap().display()
        ),
        "cargo" => {
            ensure!(
                paths.len() == 1
                    && paths[0].starts_with("tests/")
                    && paths[0].ends_with(".rs")
                    && !paths[0][6..].contains('/'),
                "Cargo repro requires one integration test in tests/<name>.rs"
            );
            format!(
                "cargo test --locked --test {} -- --nocapture",
                &paths[0][6..paths[0].len() - 3]
            )
        }
        "go" => {
            ensure!(
                paths.iter().all(|p| p.ends_with("_test.go")),
                "Go repro requires test files"
            );
            // Named test files alone omit implementation; run their package, never a free filter.
            let mut dirs = paths
                .iter()
                .map(|p| {
                    p.rsplit_once('/')
                        .map(|(d, _)| format!("./{d}"))
                        .unwrap_or_else(|| ".".into())
                })
                .collect::<Vec<_>>();
            dirs.sort();
            dirs.dedup();
            format!("go test -json {}", dirs.join(" "))
        }
        _ => bail!("Unsupported runner; use skip_repro(no_cheap_test_path)"),
    };
    let fingerprint = evidence::hex(&Sha256::digest(format!(
        "{runner}\n{}\n{}",
        req.cwd, snapshot.test_identity
    )));
    Ok(Prepared {
        request: req,
        runner,
        command,
        fingerprint,
        tree: snapshot.tree,
        report,
    })
}

#[derive(Debug, Default, PartialEq, Serialize)]
pub struct Results {
    pub failed: Vec<String>,
    pub passed: Vec<String>,
    pub assertion: String,
    pub sources: std::collections::BTreeMap<String, String>,
}
/// Fail closed on collection/import/compile errors. JSON reporters and JUnit are
/// bounded to 1 MiB; Cargo's stable harness is accepted only after tests start.
pub fn classify(runner: &str, output: &str, exit: Option<i32>) -> Results {
    if output.len() > 1_048_576 || exit.is_none() || matches!(exit, Some(124 | 126 | 127 | 137)) {
        return Results::default();
    }
    let mut r = Results::default();
    match runner {
        "vitest" | "jest" => {
            let Some(start) = output.find('{') else {
                return r;
            };
            let Ok(v) = serde_json::from_str::<Value>(output[start..].trim()) else {
                return r;
            };
            if v["numRuntimeErrorTestSuites"].as_u64().unwrap_or(0) > 0 {
                return r;
            }
            let Some(suites) = v["testResults"].as_array() else {
                return r;
            };
            for suite in suites {
                let Some(tests) = suite["assertionResults"]
                    .as_array()
                    .filter(|v| !v.is_empty())
                else {
                    return Results::default();
                };
                for test in tests {
                    let Some(id) = test["fullName"].as_str() else {
                        return Results::default();
                    };
                    let id = format!("{}::{id}", suite["name"].as_str().unwrap_or(""));
                    if test["status"] == "passed" {
                        r.passed.push(id.clone());
                    }
                    if test["status"] == "failed" {
                        let msg = test["failureMessages"]
                            .as_array()
                            .map(|v| {
                                v.iter()
                                    .filter_map(Value::as_str)
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_default();
                        if !js_assertion(&msg) || infrastructure(&msg) {
                            return Results::default();
                        }
                        r.sources
                            .insert(id.clone(), suite["name"].as_str().unwrap_or("").into());
                        r.failed.push(id);
                        r.assertion = msg;
                    }
                }
            }
        }
        "pytest" => {
            if output.contains("<error")
                || output.contains("<!DOCTYPE")
                || output.contains("<!ENTITY")
                || !(output.trim_end().ends_with("</testsuites>")
                    || output.trim_end().ends_with("</testsuite>"))
            {
                return r;
            }
            let cases =
                regex::Regex::new(r#"(?s)<testcase\b([^>]*)(?:/>|>(.*?)</testcase>)"#).unwrap();
            let attr = regex::Regex::new(r#"\b(classname|name)="([^"]*)""#).unwrap();
            let assertion_line = regex::Regex::new(r"(?m)^E\s+assert ").unwrap();
            for case in cases.captures_iter(output) {
                let id = attr
                    .captures_iter(&case[1])
                    .map(|c| c[2].to_owned())
                    .collect::<Vec<_>>()
                    .join("::");
                let body = case.get(2).map(|v| v.as_str()).unwrap_or("");
                if body.contains("<failure") {
                    if !(body.contains("type=\"AssertionError\"")
                        || body.contains("message=\"AssertionError")
                        || body.contains("message=\"assert ")
                        || assertion_line.is_match(body))
                        || infrastructure(body)
                    {
                        return Results::default();
                    }
                    r.failed.push(id);
                    r.assertion = body.into();
                } else if !body.contains("<skipped") {
                    r.passed.push(id);
                }
            }
        }
        "cargo" => {
            if infrastructure(output)
                || !regex::Regex::new(r"(?m)^running [1-9][0-9]* tests?$")
                    .unwrap()
                    .is_match(output)
            {
                return r;
            }
            for line in output.lines() {
                if let Some(id) = line
                    .strip_prefix("test ")
                    .and_then(|l| l.strip_suffix(" ... ok"))
                {
                    r.passed.push(id.into());
                }
                if let Some(id) = line
                    .strip_prefix("test ")
                    .and_then(|l| l.strip_suffix(" ... FAILED"))
                {
                    // Every failed test needs its own assertion panic, not a panic elsewhere.
                    let marker = regex::Regex::new(&format!(
                        r"thread '{}'(?: \([0-9]+\))? panicked at",
                        regex::escape(id)
                    ))
                    .unwrap();
                    let Some(found) = marker.find(output) else {
                        return Results::default();
                    };
                    let tail = &output[found.end()..];
                    let msg = tail.split("thread '").next().unwrap_or("");
                    if !(msg.contains("assertion failed") || msg.contains("assertion `")) {
                        return Results::default();
                    }
                    r.failed.push(id.into());
                    r.assertion = msg.into();
                }
            }
        }
        "go" => {
            let mut logs = std::collections::BTreeMap::<String, String>::new();
            let pattern = regex::Regex::new(
                r"(?m)^\s+([A-Za-z0-9_./-]+_test\.go):[0-9]+: (?:expected|assertion|want)\b",
            )
            .unwrap();
            for line in output.lines() {
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    return Results::default();
                };
                let Some(test) = v["Test"].as_str() else {
                    if v["Action"] == "build-fail"
                        || v["Output"].as_str().is_some_and(infrastructure)
                    {
                        return Results::default();
                    }
                    continue;
                };
                let id = format!("{}::{test}", v["Package"].as_str().unwrap_or(""));
                match v["Action"].as_str() {
                    Some("output") => logs
                        .entry(id)
                        .or_default()
                        .push_str(v["Output"].as_str().unwrap_or("")),
                    Some("pass") => r.passed.push(id),
                    Some("fail") => {
                        let msg = logs.get(&id).cloned().unwrap_or_default();
                        let Some(source) = pattern.captures(&msg).map(|c| c[1].to_owned()) else {
                            return Results::default();
                        };
                        if infrastructure(&msg) || msg.contains("panic:") {
                            return Results::default();
                        }
                        r.sources.insert(id.clone(), source);
                        r.failed.push(id);
                        r.assertion = msg;
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    r.failed.sort();
    r.failed.dedup();
    r.passed.sort();
    r.passed.dedup();
    if r.failed.len() > 100
        || r.passed.len() > 1000
        || r.failed.iter().chain(&r.passed).any(|s| s.len() > 1024)
    {
        return Results::default();
    }
    r
}
fn js_assertion(s: &str) -> bool {
    let clean = evidence::scrub(s, 4096);
    let first = clean.trim_start();
    first.starts_with("AssertionError:")
        || first.starts_with("Error: expect(")
        || first.starts_with("expect(")
}

/// Reporter failures must originate in the requested changed files. Go runs a
/// package, so require both a matching source location and a declaration there.
pub fn attributed(root: &Path, prepared: &Prepared, parsed: &Value, cases: &[String]) -> bool {
    if matches!(prepared.runner.as_str(), "vitest" | "jest") {
        return cases.iter().all(|id| {
            parsed["sources"][id].as_str().is_some_and(|source| {
                prepared.request.test_files.iter().any(|p| {
                    let target = root.join(p);
                    let reported = if Path::new(source).is_absolute() {
                        Path::new(source).to_owned()
                    } else {
                        root.join(&prepared.request.cwd).join(source)
                    };
                    target
                        .canonicalize()
                        .ok()
                        .zip(reported.canonicalize().ok())
                        .is_some_and(|(a, b)| a == b)
                })
            })
        });
    }
    if prepared.runner == "go" {
        let manifest = std::fs::read_to_string(root.join(&prepared.request.cwd).join("go.mod"))
            .unwrap_or_default();
        let Some(module) = manifest
            .lines()
            .find_map(|line| line.trim().strip_prefix("module ").map(str::trim))
        else {
            return false;
        };
        return cases.iter().all(|id| {
            let test = id
                .rsplit("::")
                .next()
                .unwrap_or("")
                .split('/')
                .next()
                .unwrap_or("");
            parsed["sources"][id].as_str().is_some_and(|source| {
                prepared.request.test_files.iter().any(|p| {
                    let relative = if prepared.request.cwd == "." {
                        Path::new(p)
                    } else {
                        let Ok(relative) = Path::new(p).strip_prefix(&prepared.request.cwd) else {
                            return false;
                        };
                        relative
                    };
                    let directory = relative.parent().unwrap_or(Path::new(""));
                    let package = if directory.as_os_str().is_empty() {
                        module.to_owned()
                    } else {
                        format!("{module}/{}", directory.display())
                    };
                    let location = root
                        .join(&prepared.request.cwd)
                        .join(directory)
                        .join(source);
                    let same = id
                        .split_once("::")
                        .is_some_and(|(actual, _)| actual == package)
                        && location
                            .canonicalize()
                            .ok()
                            .zip(root.join(p).canonicalize().ok())
                            .is_some_and(|(a, b)| a == b);
                    same && std::fs::read_to_string(root.join(p)).ok().is_some_and(|s| {
                        regex::Regex::new(&format!(r"(?m)^func\s+{}\s*\(", regex::escape(test)))
                            .unwrap()
                            .is_match(&s)
                    })
                })
            })
        });
    }
    // Cargo selects one integration target; pytest receives exact file paths.
    true
}

fn infrastructure(s: &str) -> bool {
    [
        "could not compile",
        "error[E",
        "SyntaxError",
        "ImportError",
        "ModuleNotFoundError",
        "Cannot find module",
        "Failed to resolve import",
        "ReferenceError",
        "build failed",
        "[build failed]",
        "undefined:",
    ]
    .iter()
    .any(|x| s.contains(x))
}
