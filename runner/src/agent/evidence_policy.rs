//! Base-pinned evidence requirements. Repository policy may add checks, but only
//! deployment configuration can authorize weakening the defaults.
//!
//! Git runs against a disposable repository with the checkout's object store as
//! an alternate, never against its config, index, hooks, or info/exclude. No
//! inherited environment (in particular relay credentials) reaches Git.
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

const POLICY_PATH: &str = ".gond-agent/evidence.toml";
const POLICY_LIMIT: usize = 16 * 1024;
const MANIFEST_LIMIT: usize = 1024 * 1024;
const CHECK_LIMIT: usize = 32;
const MALFORMED: &str =
    "Repository evidence policy was unreadable or invalid; default requirements were retained.";
const REFUSED: &str = "Repository evidence policy requested weaker requirements; deployment configuration did not permit this.";
const DISCOVERY_FAILED: &str =
    "Evidence discovery could not read the pinned base; no repository weakening was applied.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvidencePolicy {
    pub enabled: bool,
    pub checks: Vec<CheckCommand>,
    pub ui: UiRequirement,
    pub source: String,
    pub notes: Vec<String>,
    pub base: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CheckCommand {
    pub command: String,
    /// Repository-relative, normalized; the repository root is `.`.
    pub cwd: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UiRequirement {
    #[default]
    Attempt,
    None,
}

impl Default for EvidencePolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            checks: Vec::new(),
            ui: UiRequirement::Attempt,
            source: "defaults".into(),
            notes: Vec::new(),
            base: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Requirements {
    pub changed: bool,
    pub docs_only: bool,
    pub ui: bool,
}

// No extensible glob fields: docs classification is fixed below, not controlled
// by a checkout (or even by a base-pinned repository policy).
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoPolicy {
    enabled: Option<bool>,
    checks: Option<Vec<CheckCommand>>,
    ui: Option<UiRequirement>,
}

/// Discover once at run spawn. Keep this value for the entire turn: neither a
/// later HEAD nor an edited policy/manifest may change its requirements.
pub fn discover(cwd: &Path) -> EvidencePolicy {
    discover_with(
        cwd,
        std::env::var("GOND_AGENT_EVIDENCE_BASE_SHA")
            .ok()
            .filter(|v| !v.is_empty())
            .as_deref(),
        std::env::var("GOND_AGENT_EVIDENCE").ok().as_deref() == Some("off"),
        std::env::var("GOND_AGENT_EVIDENCE_REPO_POLICY")
            .ok()
            .as_deref()
            == Some("allow-weaken"),
    )
}

fn discover_with(cwd: &Path, base: Option<&str>, off: bool, allow_weaken: bool) -> EvidencePolicy {
    let mut policy = EvidencePolicy {
        enabled: !off,
        ..EvidencePolicy::default()
    };
    let result = (|| -> Result<()> {
        let repo = Repository::new(cwd)?;
        policy.base = match base {
            Some(base) => {
                oid(base)?;
                base.to_owned()
            }
            None => repo.head()?.context("Missing evidence base")?,
        };
        ensure!(
            repo.git(&["cat-file", "-t", &policy.base])? == b"commit\n",
            "Invalid evidence base"
        );
        policy.source = format!("{}:manifests", policy.base);
        // Parse ls-tree records rather than interpolating repository paths in a
        // revision expression. Only regular files are manifests or policy.
        let files = repo.files(&policy.base)?;
        for file in &files {
            let Some(path) = file.path.as_deref() else {
                continue;
            };
            if path == POLICY_PATH {
                continue;
            }
            let (directory, name) = path.rsplit_once('/').unwrap_or((".", path));
            if normalized_cwd(directory).is_err() {
                continue;
            }
            match name {
                "Cargo.toml" => {
                    policy.add("cargo test --locked", directory);
                    policy.add(
                        "cargo clippy --all-targets --locked -- -D warnings",
                        directory,
                    );
                }
                "package.json" => {
                    let Some(bytes) = repo.blob(&file.oid, MANIFEST_LIMIT)? else {
                        continue;
                    };
                    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                        continue;
                    };
                    for (script, command) in [
                        ("test", "npm test"),
                        ("lint", "npm run lint"),
                        ("typecheck", "npm run typecheck"),
                    ] {
                        if value
                            .get("scripts")
                            .and_then(|s| s.get(script))
                            .and_then(|s| s.as_str())
                            .is_some_and(|s| !s.trim().is_empty())
                        {
                            policy.add(command, directory);
                        }
                    }
                }
                "pytest.ini" => policy.add("pytest", directory),
                "pyproject.toml" | "setup.cfg" | "requirements.txt" => {
                    let Some(bytes) = repo.blob(&file.oid, MANIFEST_LIMIT)? else {
                        continue;
                    };
                    if let Ok(text) = std::str::from_utf8(&bytes) {
                        if pytest_manifest(name, text) {
                            policy.add("pytest", directory);
                        }
                    }
                }
                _ => {}
            }
        }
        if let Some(file) = files
            .iter()
            .find(|f| f.path.as_deref() == Some(POLICY_PATH))
        {
            policy.source = format!("{}:{POLICY_PATH}", policy.base);
            let parsed = (|| -> Result<RepoPolicy> {
                let bytes = repo
                    .blob(&file.oid, POLICY_LIMIT)?
                    .context("Evidence policy too large")?;
                let text = std::str::from_utf8(&bytes)?;
                let parsed: RepoPolicy = toml::from_str(text)?;
                if let Some(checks) = &parsed.checks {
                    ensure!(checks.len() <= CHECK_LIMIT, "Too many evidence checks");
                    for check in checks {
                        validate_check(check)?;
                    }
                }
                Ok(parsed)
            })();
            match parsed {
                Ok(parsed) => {
                    if !allow_weaken
                        && (parsed.enabled == Some(false) || parsed.ui == Some(UiRequirement::None))
                    {
                        policy.notes.push(REFUSED.into());
                    }
                    if allow_weaken {
                        if parsed.enabled == Some(false) || parsed.ui == Some(UiRequirement::None) {
                            policy.notes.push("Deployment allowed weaker repository evidence requirements (enabled=false or ui=none).".into());
                        }
                        policy.enabled = !off && parsed.enabled.unwrap_or(true);
                        policy.ui = parsed.ui.unwrap_or(UiRequirement::Attempt);
                    }
                    for check in parsed.checks.unwrap_or_default() {
                        policy.add(&check.command, &check.cwd);
                    }
                }
                Err(_) => policy.notes.push(MALFORMED.into()),
            }
        }
        Ok(())
    })();
    if result.is_err() {
        // Never include TOML, paths, Git stderr, or command text in PR notes.
        policy.notes.push(DISCOVERY_FAILED.into());
    }
    policy
}

impl EvidencePolicy {
    fn add(&mut self, command: &str, cwd: &str) {
        let check = CheckCommand {
            command: command.into(),
            cwd: cwd.into(),
        };
        if !self.checks.contains(&check) {
            self.checks.push(check);
        }
    }

    /// Classify the exact snapshot being gated. `tree_oid` is the result of
    /// evidence_tree::tree_hash, whose private object store no longer exists.
    /// Rebuild that same tree in our own scratch repo and verify the OID before
    /// comparing to BASE. This also detects edits between capture and gating.
    /// HEAD/index/config/object storage in the checkout are never modified.
    pub fn requirements(&self, cwd: &Path, tree_oid: &str) -> Result<Requirements> {
        oid(&self.base)?;
        oid(tree_oid)?;
        let repo = Repository::new(cwd)?;
        let tree = repo.snapshot()?;
        ensure!(
            tree == tree_oid,
            "Evidence snapshot changed during classification"
        );
        ensure!(
            repo.git(&["cat-file", "-t", &self.base])? == b"commit\n",
            "Invalid evidence base"
        );
        let paths = repo.git(&[
            "diff-tree",
            "--no-commit-id",
            "--no-renames",
            "--name-only",
            "-r",
            "-z",
            &self.base,
            &tree,
            "--",
        ])?;
        let paths: Vec<_> = paths.split(|b| *b == 0).filter(|p| !p.is_empty()).collect();
        let changed = !paths.is_empty();
        // Fixed globs: *.md at root, docs/**/*.md (including new documents).
        // Non-UTF8 paths, Markdown elsewhere, and symlinks are not docs-only.
        let mut docs_only = changed && paths.iter().all(|p| docs_path(p));
        if docs_only {
            for revision in [&self.base, &tree] {
                let files = repo.git(&["ls-tree", "-rz", revision])?;
                for record in files.split(|b| *b == 0).filter(|r| !r.is_empty()) {
                    if let Some(tab) = record.iter().position(|b| *b == b'\t') {
                        if paths.contains(&&record[tab + 1..]) && !record.starts_with(b"100") {
                            docs_only = false;
                        }
                    }
                }
            }
        }
        Ok(Requirements {
            changed,
            docs_only,
            ui: self.enabled
                && changed
                && !docs_only
                && self.ui == UiRequirement::Attempt
                && paths.iter().any(|p| {
                    std::str::from_utf8(p).map_or(true, |p| {
                        p.starts_with("web/") || p.ends_with(".tsx") || p.ends_with(".css")
                    })
                }),
        })
    }
}

fn docs_path(bytes: &[u8]) -> bool {
    let Ok(path) = std::str::from_utf8(bytes) else {
        return false;
    };
    path.ends_with(".md") && (!path.contains('/') || path.starts_with("docs/"))
}

fn normalized_cwd(cwd: &str) -> Result<()> {
    ensure!(
        !cwd.is_empty() && cwd.len() <= 1024,
        "Invalid evidence working directory"
    );
    ensure!(
        cwd == "."
            || cwd
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != ".."),
        "Invalid evidence working directory"
    );
    ensure!(
        !cwd.contains('\\') && !cwd.contains(':') && !cwd.chars().any(char::is_control),
        "Invalid evidence working directory"
    );
    Ok(())
}

fn validate_check(check: &CheckCommand) -> Result<()> {
    normalized_cwd(&check.cwd)?;
    let command = &check.command;
    ensure!(
        !command.is_empty() && command.len() <= 200 && command.trim() == command,
        "Invalid evidence command"
    );
    // A single, literal command only. No quoting/expansion, redirects, shell
    // operators, globs, command substitutions, or control characters.
    ensure!(
        command
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b" _-./:=+@%,".contains(&b)),
        "Invalid evidence command"
    );
    let program = command.split(' ').next().unwrap_or("");
    ensure!(
        program
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-./".contains(&b)),
        "Invalid evidence command"
    );
    let executable = program.rsplit('/').next().unwrap_or("");
    ensure!(
        !executable.is_empty() && !executable.starts_with('-'),
        "Invalid evidence command"
    );
    ensure!(
        !matches!(
            executable,
            "sh" | "bash"
                | "dash"
                | "zsh"
                | "fish"
                | "csh"
                | "ksh"
                | "env"
                | "eval"
                | "exec"
                | "command"
                | "builtin"
                | "true"
                | "false"
                | ":"
                | "."
                | "source"
                | "exit"
                | "return"
                | "export"
                | "set"
                | "unset"
                | "grep"
                | "egrep"
                | "fgrep"
                | "rg"
                | "sed"
                | "awk"
                | "gawk"
                | "mawk"
                | "head"
                | "tail"
                | "cut"
                | "sort"
                | "uniq"
                | "tr"
                | "tee"
                | "xargs"
                | "cat"
                | "echo"
                | "printf"
                | "wc"
                | "yes"
        ),
        "Invalid evidence command"
    );
    Ok(())
}

fn pytest_dependency(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    value.strip_prefix("pytest").is_some_and(|rest| {
        rest.is_empty()
            || rest.starts_with(|c: char| c.is_ascii_whitespace() || "[<>=!~;@".contains(c))
    })
}

fn pytest_value(value: &toml::Value) -> bool {
    match value {
        toml::Value::String(value) => pytest_dependency(value),
        toml::Value::Array(values) => values.iter().any(pytest_value),
        toml::Value::Table(values) => values
            .iter()
            .any(|(key, value)| key == "pytest" || pytest_value(value)),
        _ => false,
    }
}

fn pytest_manifest(name: &str, text: &str) -> bool {
    if name == "pyproject.toml" {
        return toml::from_str::<toml::Value>(text).is_ok_and(|value| pytest_value(&value));
    }
    text.lines().any(|line| {
        let line = line.split('#').next().unwrap_or("").trim();
        (name == "setup.cfg" && line == "[tool:pytest]") || pytest_dependency(line)
    })
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let path =
            PathBuf::from("/tmp").join(format!("gond-evidence-policy-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(&path)?;
        }
        #[cfg(not(unix))]
        fs::create_dir(&path)?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Repository {
    root: PathBuf,
    gitdir: PathBuf,
    scratch: Scratch,
}

struct File {
    path: Option<String>,
    oid: String,
}

impl Repository {
    fn command(&self) -> Command {
        let mut command = Command::new("/usr/bin/git");
        command
            .current_dir(&self.root)
            .env_clear()
            .envs([
                ("PATH", "/usr/bin:/bin"),
                ("LC_ALL", "C"),
                ("GIT_CONFIG_NOSYSTEM", "1"),
                ("GIT_CONFIG_SYSTEM", "/dev/null"),
                ("GIT_CONFIG_GLOBAL", "/dev/null"),
                ("GIT_OPTIONAL_LOCKS", "0"),
                ("GIT_NO_REPLACE_OBJECTS", "1"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GIT_ALLOW_PROTOCOL", "file"),
                ("GIT_ATTR_NOSYSTEM", "1"),
            ])
            .env("HOME", &self.scratch.0)
            .args([
                "-c",
                "core.hooksPath=/dev/null",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.attributesFile=/dev/null",
                "-c",
                "core.excludesFile=/dev/null",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "credential.helper=",
                "-c",
                "transfer.fsckObjects=true",
                "-c",
                "fetch.fsckObjects=true",
            ]);
        command
    }

    fn git(&self, args: &[&str]) -> Result<Vec<u8>> {
        let output = self
            .command()
            .env("GIT_DIR", self.scratch.0.join("repo/.git"))
            .env("GIT_WORK_TREE", &self.root)
            .env("GIT_INDEX_FILE", self.scratch.0.join("index"))
            .env(
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                self.gitdir.join("objects"),
            )
            .args(args)
            .output()
            .context("Could not read evidence repository")?;
        ensure!(output.status.success(), "The evidence Git operation failed");
        Ok(output.stdout)
    }

    fn new(cwd: &Path) -> Result<Self> {
        let root = cwd.canonicalize()?;
        let gitdir = root.join(".git");
        ensure!(
            !gitdir.is_symlink() && gitdir.is_dir() && !gitdir.join("objects").is_symlink(),
            "Unsupported evidence repository layout"
        );
        let repo = Self {
            root,
            gitdir,
            scratch: Scratch::new()?,
        };
        let output = repo
            .command()
            .args(["init", "--quiet", "--template="])
            .arg(repo.scratch.0.join("repo"))
            .output()?;
        ensure!(output.status.success(), "The evidence Git operation failed");
        let shallow = repo.local_file("shallow")?;
        if shallow.exists() {
            let content = fs::read_to_string(shallow)?;
            for line in content.lines() {
                oid(line)?;
            }
            fs::write(repo.scratch.0.join("repo/.git/shallow"), content)?;
        }
        Ok(repo)
    }

    fn local_file(&self, name: &str) -> Result<PathBuf> {
        let path = self.gitdir.join(name);
        ensure!(!path.is_symlink(), "Unsupported evidence repository layout");
        let mut parent = path.as_path();
        while fs::symlink_metadata(parent).is_err() {
            parent = parent
                .parent()
                .context("Unsupported evidence repository layout")?;
        }
        ensure!(
            parent.canonicalize()?.starts_with(&self.gitdir),
            "Unsupported evidence repository layout"
        );
        Ok(path)
    }

    fn head(&self) -> Result<Option<String>> {
        let content = fs::read_to_string(self.local_file("HEAD")?)?;
        let mut head = content.trim().to_owned();
        if let Some(reference) = head.strip_prefix("ref: ") {
            ensure!(
                reference.starts_with("refs/heads/"),
                "Unsupported evidence HEAD"
            );
            self.git(&["check-ref-format", reference])?;
            let loose = self.local_file(reference)?;
            head = if loose.exists() {
                fs::read_to_string(loose)?.trim().to_owned()
            } else {
                let packed = self.local_file("packed-refs")?;
                let content = if packed.exists() {
                    fs::read_to_string(packed)?
                } else {
                    String::new()
                };
                let matches: Vec<_> = content
                    .lines()
                    .filter_map(|line| {
                        let parts: Vec<_> = line.split_whitespace().collect();
                        (parts.len() == 2 && parts[1] == reference).then(|| parts[0].to_owned())
                    })
                    .collect();
                if matches.is_empty() {
                    return Ok(None);
                }
                ensure!(matches.len() == 1, "Invalid evidence HEAD");
                matches[0].clone()
            };
        }
        oid(&head)?;
        ensure!(
            self.git(&["cat-file", "-t", &head])? == b"commit\n",
            "Invalid evidence commit"
        );
        Ok(Some(head))
    }

    fn files(&self, revision: &str) -> Result<Vec<File>> {
        let output = self.git(&["ls-tree", "-rz", revision])?;
        let mut files = Vec::new();
        for record in output.split(|b| *b == 0).filter(|r| !r.is_empty()) {
            let tab = record
                .iter()
                .position(|b| *b == b'\t')
                .context("Invalid evidence tree")?;
            let header = std::str::from_utf8(&record[..tab])?
                .split_whitespace()
                .collect::<Vec<_>>();
            ensure!(header.len() == 3, "Invalid evidence tree");
            if !matches!(header[0], "100644" | "100755") || header[1] != "blob" {
                continue;
            }
            oid(header[2])?;
            files.push(File {
                path: std::str::from_utf8(&record[tab + 1..])
                    .ok()
                    .map(str::to_owned),
                oid: header[2].into(),
            });
        }
        Ok(files)
    }

    fn blob(&self, object: &str, limit: usize) -> Result<Option<Vec<u8>>> {
        oid(object)?;
        // Size probe MUST precede reading policy contents.
        let size = self.git(&["cat-file", "-s", object])?;
        let size: usize = std::str::from_utf8(&size)?.trim().parse()?;
        if size > limit {
            return Ok(None);
        }
        let content = self.git(&["cat-file", "blob", object])?;
        ensure!(
            content.len() == size && content.len() <= limit,
            "Invalid evidence blob"
        );
        Ok(Some(content))
    }

    fn snapshot(&self) -> Result<String> {
        let head = self.head()?;
        let index = self.local_file("index")?;
        if index.exists() {
            let output = self
                .command()
                .env("GIT_DIR", self.scratch.0.join("repo/.git"))
                .env("GIT_WORK_TREE", &self.root)
                .env("GIT_INDEX_FILE", &index)
                .env(
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                    self.gitdir.join("objects"),
                )
                .args([
                    "ls-files",
                    "--cached",
                    "--ignored",
                    "--exclude-standard",
                    "-z",
                ])
                .output()?;
            ensure!(output.status.success(), "The evidence Git operation failed");
            let tracked = match &head {
                Some(head) => self.git(&["ls-tree", "-rz", "--name-only", head])?,
                None => Vec::new(),
            };
            let tracked: HashSet<_> = tracked.split(|b| *b == 0).collect();
            ensure!(
                !output
                    .stdout
                    .split(|b| *b == 0)
                    .any(|p| !p.is_empty() && !tracked.contains(p)),
                "Newly staged ignored files are not supported by checkpoints"
            );
        }
        self.git(&["read-tree", head.as_deref().unwrap_or("--empty")])?;
        self.git(&["add", "--all", "--", "."])?;
        let tree = String::from_utf8(self.git(&["write-tree"])?)?
            .trim()
            .to_owned();
        oid(&tree)?;
        Ok(tree)
    }
}

fn oid(value: &str) -> Result<()> {
    ensure!(
        value.len() == 40
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid evidence revision"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) -> String {
        let output = Command::new("/usr/bin/git")
            .current_dir(root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", root)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_AUTHOR_NAME", "fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
            .env("GIT_COMMITTER_NAME", "fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().into()
    }

    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init", "-q", "-b", "run"]);
        fs::write(temp.path().join("README.md"), "base\n").unwrap();
        temp
    }

    fn commit(root: &Path) -> String {
        git(root, &["add", "--all"]);
        git(root, &["commit", "-qm", "fixture"]);
        git(root, &["rev-parse", "HEAD"])
    }

    fn write_policy(root: &Path, text: &str) {
        fs::create_dir_all(root.join(".gond-agent")).unwrap();
        fs::write(root.join(POLICY_PATH), text).unwrap();
    }

    #[test]
    fn discovery_is_base_pinned_additive_and_cannot_weaken() {
        let temp = fixture();
        let root = temp.path();
        fs::create_dir_all(root.join("web")).unwrap();
        fs::write(
            root.join("web/package.json"),
            r#"{"scripts":{"test":"hostile || true","lint":"lint","typecheck":"tsc"}}"#,
        )
        .unwrap();
        fs::write(root.join("Cargo.toml"), "[package]\nname='fixture'\n").unwrap();
        fs::write(
            root.join("pyproject.toml"),
            "[tool.pytest.ini_options]\naddopts='-q'\n",
        )
        .unwrap();
        write_policy(
            root,
            "enabled=false\nui='none'\n[[checks]]\ncommand='make verify'\ncwd='.'\n",
        );
        let base = commit(root);
        fs::write(root.join("web/package.json"), "{}").unwrap();
        write_policy(root, "checks=[]\n");
        let head = commit(root);
        assert_eq!(discover_with(root, None, false, false).base, head);
        let policy = discover_with(root, Some(&base), false, false);
        assert!(policy.enabled);
        assert_eq!(policy.ui, UiRequirement::Attempt);
        assert_eq!(policy.notes, [REFUSED]);
        assert_eq!(policy.source, format!("{base}:{POLICY_PATH}"));
        assert_eq!(policy.checks.len(), 7);
        assert!(policy.checks.contains(&CheckCommand {
            command: "npm test".into(),
            cwd: "web".into()
        }));
        assert!(policy.checks.contains(&CheckCommand {
            command: "make verify".into(),
            cwd: ".".into()
        }));
        let allowed = discover_with(root, Some(&base), false, true);
        assert!(!allowed.enabled);
        assert_eq!(allowed.ui, UiRequirement::None);
        assert_eq!(allowed.checks, policy.checks);
        assert!(!discover_with(root, Some(&base), true, false).enabled);
    }

    #[test]
    fn malformed_oversized_or_unsafe_policy_falls_back_without_echoing_input() {
        let temp = fixture();
        let root = temp.path();
        fs::write(root.join("package.json"), r#"{"scripts":{"test":"test"}}"#).unwrap();
        for text in [
            "docs=['**']".to_owned(),
            "[[checks]]\ncommand='npm test || true'\ncwd='.'".to_owned(),
            "[[checks]]\ncommand='grep PASS result'\ncwd='.'".to_owned(),
            "[[checks]]\ncommand='make check'\ncwd='../escape'".to_owned(),
            format!("#{}", "secret".repeat(POLICY_LIMIT)),
            "[[checks]]\ncommand='make check'\ncwd='.'\n".repeat(CHECK_LIMIT + 1),
            format!("[[checks]]\ncommand='make {}'\ncwd='.'", "x".repeat(200)),
        ] {
            write_policy(root, &text);
            let base = commit(root);
            let policy = discover_with(root, Some(&base), false, false);
            assert_eq!(policy.notes, [MALFORMED]);
            assert_eq!(
                policy.checks,
                [CheckCommand {
                    command: "npm test".into(),
                    cwd: ".".into()
                }]
            );
            assert!(policy.enabled);
        }
    }

    #[test]
    fn requirements_include_untracked_and_committed_changes_without_local_excludes_or_config() {
        let temp = fixture();
        let root = temp.path();
        let base = commit(root);
        let policy = discover_with(root, Some(&base), false, false);
        let initial = super::super::evidence_tree::tree_hash(root).unwrap();
        assert_eq!(
            policy.requirements(root, &initial).unwrap(),
            Requirements {
                changed: false,
                docs_only: false,
                ui: false
            }
        );
        fs::create_dir(root.join("docs")).unwrap();
        fs::write(root.join("docs/new.md"), "new docs\n").unwrap();
        let docs = super::super::evidence_tree::tree_hash(root).unwrap();
        assert_eq!(
            policy.requirements(root, &docs).unwrap(),
            Requirements {
                changed: true,
                docs_only: true,
                ui: false
            }
        );
        commit(root);
        fs::write(root.join(".git/info/exclude"), "hidden.rs\n").unwrap();
        git(root, &["config", "core.fsmonitor", "touch monitor-ran"]);
        git(
            root,
            &["config", "filter.hostile.clean", "touch filter-ran; cat"],
        );
        fs::write(root.join(".gitattributes"), "hidden.rs filter=hostile\n").unwrap();
        fs::write(root.join("hidden.rs"), "fn main() {}\n").unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        let snapshot = super::super::evidence_tree::tree_hash(root).unwrap();
        assert_eq!(
            policy.requirements(root, &snapshot).unwrap(),
            Requirements {
                changed: true,
                docs_only: false,
                ui: false
            }
        );
        assert_eq!(index, fs::read(root.join(".git/index")).unwrap());
        assert!(!root.join("monitor-ran").exists());
        assert!(!root.join("filter-ran").exists());
        fs::write(root.join("hidden.rs"), "changed\n").unwrap();
        assert!(policy.requirements(root, &snapshot).is_err());
    }

    #[test]
    fn validation_and_fixed_docs_rules_are_conservative() {
        for cwd in [
            "", "/tmp", "../x", "x/../y", "x//y", "x/", "./x", "x\\y", "C:/x",
        ] {
            assert!(normalized_cwd(cwd).is_err(), "{cwd}");
        }
        for command in [
            "npm test\ntrue",
            "npm test | cat",
            "npm test && true",
            "npm test > log",
            "echo ok",
            "bash -c true",
            "npm test $(true)",
            "PASS=yes",
            ". script",
        ] {
            assert!(
                validate_check(&CheckCommand {
                    command: command.into(),
                    cwd: ".".into()
                })
                .is_err()
            );
        }
        assert!(docs_path(b"README.md"));
        assert!(docs_path(b"docs/new/note.md"));
        assert!(!docs_path(b"src/note.md"));
        assert!(!docs_path(b"docs/code.rs"));
        assert!(pytest_manifest("requirements.txt", "pytest>=8\n"));
        assert!(!pytest_manifest(
            "requirements.txt",
            "# pytest\nnotpytest>=1\n"
        ));
        assert!(toml::from_str::<RepoPolicy>("ui='never'").is_err());
        assert!(
            toml::from_str::<RepoPolicy>("[[checks]]\ncommand='make'\ncwd='.'\nextra=true")
                .is_err()
        );
    }
}
