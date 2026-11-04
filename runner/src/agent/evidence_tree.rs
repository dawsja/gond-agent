//! Canonical worktree identity, mirrored by containers/agent.py::capture_tree.
//!
//! Never load checkout Git config, refs via Git discovery, or info/exclude. Only
//! HEAD-tracked files and untracked files allowed by worktree .gitignore belong
//! to this tree. Ignored code is NOT covered by evidence for this OID.
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail, ensure};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        // Match the service: do not trust inherited TMPDIR or workspace config.
        let path = PathBuf::from("/tmp").join(format!("gond-evidence-{}", uuid::Uuid::new_v4()));
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

    fn git(&self, args: &[&str], index: Option<&Path>) -> Result<Vec<u8>> {
        let output = self
            .command()
            .env("GIT_DIR", self.scratch.0.join("repo/.git"))
            .env("GIT_WORK_TREE", &self.root)
            .env(
                "GIT_INDEX_FILE",
                index
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| self.scratch.0.join("index")),
            )
            .env(
                "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                self.gitdir.join("objects"),
            )
            .args(args)
            .output()
            .context("Could not capture the evidence tree")?;
        // Do not expose untrusted Git diagnostics, paths or embedded secrets.
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
        let shallow = repo.clone_file("shallow")?;
        if shallow.exists() {
            let content = fs::read_to_string(shallow)?;
            for line in content.lines() {
                oid(line)?;
            }
            fs::write(repo.scratch.0.join("repo/.git/shallow"), content)?;
        }
        Ok(repo)
    }

    fn clone_file(&self, name: &str) -> Result<PathBuf> {
        let path = self.gitdir.join(name);
        ensure!(!path.is_symlink(), "Unsupported evidence repository layout");
        // Like Path.resolve(strict=False) in Python, also check existing parents
        // when the leaf (e.g. an unpacked ref) does not exist yet. Stop at a
        // dangling symlink too, so canonicalization fails closed.
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
        let content = fs::read_to_string(self.clone_file("HEAD")?)?;
        let mut head = content.trim().to_owned();
        if let Some(reference) = head.strip_prefix("ref: ") {
            ensure!(
                reference.starts_with("refs/heads/"),
                "Unsupported evidence HEAD"
            );
            self.git(&["check-ref-format", reference], None)?;
            let loose = self.clone_file(reference)?;
            head = if loose.exists() {
                fs::read_to_string(loose)?.trim().to_owned()
            } else {
                let packed = self.clone_file("packed-refs")?;
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
                ensure!(matches.len() == 1, "Missing evidence HEAD");
                matches[0].clone()
            };
        }
        oid(&head)?;
        ensure!(
            self.git(&["cat-file", "-t", &head], None)? == b"commit\n",
            "Invalid evidence commit"
        );
        Ok(Some(head))
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

/// Hash exactly the tree checkpoint_tree and snapshot publish, without changing
/// the checkout's index, HEAD, refs, config, or object store. Call on the repo root.
/// Newly force-staged ignored files fail closed, just as in the service.
pub fn tree_hash(cwd: &Path) -> Result<String> {
    let repo = Repository::new(cwd)?;
    capture(&repo)
}

fn capture(repo: &Repository) -> Result<String> {
    let head = repo.head()?;
    let index = repo.clone_file("index")?;
    if index.exists() {
        let ignored = repo.git(
            &[
                "ls-files",
                "--cached",
                "--ignored",
                "--exclude-standard",
                "-z",
            ],
            Some(&index),
        )?;
        let tracked = match &head {
            Some(head) => repo.git(&["ls-tree", "-rz", "--name-only", head], None)?,
            None => Vec::new(),
        };
        let tracked: HashSet<&[u8]> = tracked.split(|b| *b == 0).collect();
        if ignored
            .split(|b| *b == 0)
            .any(|path| !path.is_empty() && !tracked.contains(path))
        {
            bail!("Newly staged ignored files are not supported by checkpoints");
        }
    }
    repo.git(&["read-tree", head.as_deref().unwrap_or("--empty")], None)?;
    let output = repo
        .command()
        .env("GIT_DIR", repo.scratch.0.join("repo/.git"))
        .env("GIT_WORK_TREE", &repo.root)
        .env("GIT_INDEX_FILE", repo.scratch.0.join("index"))
        .env(
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            repo.gitdir.join("objects"),
        )
        .args(["add", "--all", "--"])
        .arg(&repo.root)
        .output()?;
    ensure!(output.status.success(), "The evidence Git operation failed");
    let tree = String::from_utf8(repo.git(&["write-tree"], None)?)?
        .trim()
        .to_owned();
    oid(&tree)?;
    Ok(tree)
}

pub struct ReproSnapshot {
    pub tree: String,
    pub non_test_equal: bool,
    pub test_identity: String,
}

pub fn repro_snapshot(cwd: &Path, base: &str, paths: &[String]) -> Result<ReproSnapshot> {
    oid(base)?;
    let repo = Repository::new(cwd)?;
    let tree = capture(&repo)?;
    let entries = |rev: &str| -> Result<std::collections::BTreeMap<String, String>> {
        let bytes = repo.git(&["ls-tree", "-rz", rev], None)?;
        let text = String::from_utf8(bytes)?;
        text.split('\0')
            .filter(|s| !s.is_empty())
            .map(|s| {
                let (metadata, path) = s.split_once('\t').context("Invalid tree entry")?;
                Ok((path.to_owned(), metadata.to_owned()))
            })
            .collect()
    };
    let original = entries(base)?;
    let current = entries(&tree)?;
    let all = original
        .keys()
        .chain(current.keys())
        .collect::<std::collections::BTreeSet<_>>();
    let changed = all
        .into_iter()
        .filter(|p| original.get(*p) != current.get(*p))
        .collect::<Vec<_>>();
    let non_test_equal = changed.iter().all(|p| {
        let regular = |entry: Option<&String>| {
            entry.is_none_or(|s| s.starts_with("100644 blob ") || s.starts_with("100755 blob "))
        };
        regular(original.get(*p)) && regular(current.get(*p)) && super::subagents::test_path(cwd, p)
    });
    // A repro may execute only newly added or changed regular test files.
    let mut identity = String::new();
    for path in paths {
        ensure!(
            changed.contains(&path),
            "Repro file is not changed from pinned base"
        );
        let entry = current
            .get(path)
            .context("Deleted tests cannot reproduce a failure")?;
        ensure!(
            entry.starts_with("100644 blob ") || entry.starts_with("100755 blob "),
            "Repro must be a regular test file"
        );
        identity.push_str(&format!("{path}\t{entry}\n"));
    }
    Ok(ReproSnapshot {
        tree,
        non_test_equal,
        test_identity: identity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &Path, args: &[&str]) -> Vec<u8> {
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
        output.stdout
    }

    #[test]
    fn isolated_tree_matches_service_and_detects_staleness_without_mutation() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        git(root, &["init", "-q", "-b", "run"]);
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();
        fs::write(root.join("tracked"), "base\n").unwrap();
        git(root, &["add", "--all"]);
        git(root, &["commit", "-qm", "base"]);
        fs::write(root.join("tracked"), "staged\n").unwrap();
        git(root, &["add", "tracked"]);
        fs::write(root.join("tracked"), "working\n").unwrap();
        fs::write(root.join(".git/info/exclude"), "hidden\n").unwrap();
        fs::write(root.join("hidden"), "included\n").unwrap();
        fs::create_dir(root.join("ignored")).unwrap();
        fs::write(root.join("ignored/code"), "outside evidence\n").unwrap();
        fs::write(root.join(".gitattributes"), "tracked filter=unsafe\n").unwrap();
        git(
            root,
            &["config", "filter.unsafe.clean", "touch filter-ran; cat"],
        );
        git(root, &["config", "core.fsmonitor", "touch monitor-ran"]);
        let index = fs::read(root.join(".git/index")).unwrap();
        let head = fs::read(root.join(".git/HEAD")).unwrap();
        let refs = git(root, &["show-ref"]);
        let first = tree_hash(root).unwrap();
        let output = Command::new("/usr/bin/python3").env_clear().env("PATH", "/usr/bin:/bin")
            .args(["-c", "import importlib.util,sys; s=importlib.util.spec_from_file_location('agent',sys.argv[1]); a=importlib.util.module_from_spec(s); s.loader.exec_module(a); a.ROOT=sys.argv[2]; print(a.tree_hash())"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../containers/agent.py"))
            .arg(root).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(first, String::from_utf8(output.stdout).unwrap().trim());
        fs::write(root.join("hidden"), "changed\n").unwrap();
        assert_ne!(first, tree_hash(root).unwrap());
        fs::write(root.join("hidden"), "included\n").unwrap();
        assert_eq!(first, tree_hash(root).unwrap());
        assert_eq!(index, fs::read(root.join(".git/index")).unwrap());
        assert_eq!(head, fs::read(root.join(".git/HEAD")).unwrap());
        assert_eq!(refs, git(root, &["show-ref"]));
        assert!(!root.join("filter-ran").exists());
        assert!(!root.join("monitor-ran").exists());
    }
}
