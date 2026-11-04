use super::*;
use crate::tools::testutil::{ctx, text};

fn repo() -> tempfile::TempDir {
    static CTAGS: LazyLock<()> = LazyLock::new(|| {
        let required = "universal-ctags not installed or incompatible: repo_map parser fixtures require Universal Ctags with JSON support; install universal-ctags on the test host, not just in the worker image";
        let version = std::process::Command::new("ctags").args(["--options=NONE", "--version"]).output().expect(required);
        assert!(version.status.success() && String::from_utf8_lossy(&version.stdout).contains("Universal Ctags"), "{required}");
        let features = std::process::Command::new("ctags").args(["--options=NONE", "--list-features"]).output().expect(required);
        assert!(features.status.success() && String::from_utf8_lossy(&features.stdout).lines().any(|line| line.split_whitespace().next() == Some("json")), "{required}");
    });
    LazyLock::force(&CTAGS);
    let dir = tempfile::tempdir().unwrap();
    assert!(std::process::Command::new("git").args(["init", "--quiet", "--template="]).arg(dir.path()).status().unwrap().success());
    dir
}
fn put(dir: &Path, name: &str, content: &[u8]) {
    let path = dir.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}
async fn build(dir: &Path) -> Map {
    let (c, _rx) = ctx(dir);
    load(&c, Limits::default(), false).await.unwrap()
}

#[tokio::test]
async fn language_fixtures_ranking_focus_and_determinism() {
    let d = repo();
    for (name, source, symbol, kind) in [
        ("a.ts", "export interface Contract {}\nexport function popular() {}\n", "Contract", "interface"),
        ("b.js", "export function javascript() {}\n", "javascript", "function"),
        ("c.rs", "pub struct RustType;\npub fn rust_function() {}\n", "RustType", "struct"),
        ("d.py", "class PythonType:\n    pass\ndef python_function():\n    pass\n", "PythonType", "class"),
        ("e.go", "package example\ntype GoType struct {}\nfunc GoFunction() {}\n", "GoFunction", "func"),
    ] {
        put(d.path(), name, source.as_bytes());
        // Each fixture must exercise the actual installed parser, not fabricated tag JSON.
        let m = build(d.path()).await;
        let f = m.files.iter().find(|f| f.path == name).unwrap();
        assert!(f.symbols.iter().any(|s| s.name == symbol && s.kind == kind && s.line > 0), "{name}: {:?}", f.symbols.iter().map(|s| (&s.name, &s.kind)).collect::<Vec<_>>());
    }
    put(d.path(), "unused.ts", b"export function unused() {}\n");
    put(d.path(), "refs1.ts", b"popular(); popular(); unpopular();\n");
    put(d.path(), "refs2.ts", b"// popular\npopular();\n");
    put(d.path(), "notes.xyzunknown", b"plain text\n");
    let m = build(d.path()).await;
    assert!(!m.partial);
    let symbol = m.files.iter().find(|f| f.path == "a.ts").unwrap().symbols.iter().find(|s| s.name == "popular").unwrap();
    assert_eq!(symbol.mentions, 2, "distinct other files, not number of occurrences or substrings");
    let out = render(&m, 2000, &[]);
    assert!(out.find("\na.ts\n").unwrap() < out.find("\nunused.ts\n").unwrap());
    let focused = render(&m, 2000, &["unused.ts".into()]);
    assert!(focused.find("\nunused.ts\n").unwrap() < focused.find("\na.ts\n").unwrap());
    assert!(!out.contains("notes.xyzunknown\n"), "unsupported files are skipped rather than snapshotted");
    assert_eq!(out, render(&build(d.path()).await, 2000, &[]));
}

#[tokio::test]
async fn cache_hit_head_version_corruption_oversize_and_private_atomic_file() {
    let d = repo();
    put(d.path(), "a.ts", b"export function original() {}\n");
    let (c, _rx) = ctx(d.path());
    let first = load(&c, Limits::default(), true).await.unwrap();
    let cache = d.path().join(".git/gond-agent/repo-map.json");
    assert!(cache.exists(), "cache not written; map:\n{}", render(&first, 2000, &[]));
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(&cache).unwrap().permissions().mode() & 0o777, 0o600); }
    assert_eq!(fs::read_dir(cache.parent().unwrap()).unwrap().count(), 1, "no leftover temp file");
    assert_eq!(render(&first, 2000, &[]), render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]));
    put(d.path(), "a.ts", b"export function edited() {}\n");
    assert!(render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]).contains("edited"), "same-HEAD edits invalidate the cache");
    assert!(cache_read(d.path(), "a different head", &first.worktree).is_none());
    let mut bad = serde_json::to_value(&first).unwrap(); bad["version"] = json!(VERSION + 1);
    fs::write(&cache, serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(cache_read(d.path(), &first.head, &first.worktree).is_none());
    for content in [b"corrupt".as_slice(), b"{}".as_slice()] {
        fs::write(&cache, content).unwrap();
        assert!(render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]).contains("edited"));
    }
    File::create(&cache).unwrap().set_len(CACHE_MAX as u64 + 1).unwrap();
    assert!(cache_read(d.path(), &first.head, &first.worktree).is_none());
    assert!(render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]).contains("edited"));
    let mut new_head = first; new_head.head = "1111111111111111111111111111111111111111".into();
    cache_write(d.path(), &new_head);
    assert!(cache_read(d.path(), "unborn", &new_head.worktree).is_none());
    assert!(cache_read(d.path(), &new_head.head, &new_head.worktree).is_some());
}

#[tokio::test]
async fn bounds_ignore_generated_binary_symlinks_and_tracked_priority() {
    let d = repo();
    put(d.path(), ".gitignore", b"ignored/\n");
    put(d.path(), "ignored/hide.ts", b"function secret() {}\n");
    for name in ["vendor/x.ts", "node_modules/x.ts", "target/x.rs", "dist/x.ts", "build/x.ts", "x.min.js", "x.map", "package-lock.json", "Cargo.lock"] { put(d.path(), name, b"function skip() {}\n"); }
    put(d.path(), "generated.ts", b"// @generated\nfunction generated() {}\n");
    put(d.path(), "binary.ts", b"\0function binary() {}\n");
    put(d.path(), "huge.ts", &vec![b'x'; 256 * 1024 + 1]);
    put(d.path(), "small.ts", b"export function small() {}\n");
    put(d.path(), "lossy.unknown", b"\xffnon utf8\n");
    #[cfg(unix)] {
        use std::os::unix::fs::symlink;
        let outside = tempfile::tempdir().unwrap();
        put(outside.path(), "escape.ts", b"function escape() {}\n");
        symlink(outside.path().join("escape.ts"), d.path().join("escape.ts")).unwrap();
        symlink(outside.path(), d.path().join("escape-dir")).unwrap();
        assert!(open_beneath(d.path(), Path::new("escape-dir/escape.ts"), false).is_err());
    }
    let m = build(d.path()).await;
    let paths: Vec<_> = m.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"small.ts") && !paths.contains(&"lossy.unknown"));
    assert!(!paths.iter().any(|p| p.contains("escape") || p.contains("ignored") || p.contains("generated") || p.contains("huge") || p.contains("binary")));
    assert!(m.skipped >= 12);
    // Tracked files must precede lexicographically earlier untracked files under a tiny cap.
    put(d.path(), "zz-tracked.ts", b"function tracked() {}\n");
    assert!(std::process::Command::new("git").current_dir(d.path()).args(["add", "--", "zz-tracked.ts"]).status().unwrap().success());
    let (c, _rx) = ctx(d.path());
    let m = load(&c, Limits { files: 1, ..Limits::default() }, false).await.unwrap();
    assert_eq!(m.files[0].path, "zz-tracked.ts"); assert!(m.partial && m.skipped > 0);
    let m = load(&c, Limits { wall: Duration::ZERO, ..Limits::default() }, false).await.unwrap();
    assert!(m.partial && m.files.is_empty());
    let m = load(&c, Limits { bytes: 1, ..Limits::default() }, false).await.unwrap();
    assert!(m.files.is_empty() && m.skipped > 0);
    // Redirected cache directories may neither be read nor written.
    #[cfg(unix)] {
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join(".git/gond-agent")).unwrap();
        cache_write(d.path(), &m);
        assert!(cache_read(d.path(), &m.head, &m.worktree).is_none());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn budget_sanitization_empty_single_and_schema_prompt_contract() {
    let d = repo();
    let (c, _rx) = ctx(d.path());
    let empty = build(d.path()).await;
    assert!(render(&empty, 2000, &[]).contains("files=0 symbols=0"));
    put(d.path(), "single.ts", b"export function one() {}\n");
    assert_eq!(build(d.path()).await.files.len(), 1);
    let mut map = Map { head: "a".repeat(40), ..Default::default() };
    for i in 0..100 { map.files.push(Entry { path: format!("file{i}\u{202e}\u{e0061}\u{fe0f}\n.ts"), symbols: (0..30).map(|j| Symbol { kind: "function".into(), name: format!("sym{j}\u{200d}\u{e0100}"), line: j, mentions: 0 }).collect() }); }
    let out = render(&map, 128, &[]);
    assert!(out.len().div_ceil(4) <= 128 && out.contains("truncated=true"));
    assert!(out.starts_with(FRAME));
    for ch in ['\u{202e}', '\u{e0061}', '\u{fe0f}', '\u{200d}', '\u{e0100}'] { assert!(!out.contains(ch)); }
    assert_eq!(clean(&"x".repeat(200)).len(), 120);
    let mut tags = Vec::new();
    for i in 0..100 { writeln!(tags, "{}", json!({"_type":"tag","path":"/scratch/0.ts","name":format!("s{i}"),"kind":"function","line":i+1})).unwrap(); }
    map.files[0].symbols.clear(); extract(&tags, &mut map, None);
    assert_eq!(map.files[0].symbols.len(), 30);
    assert!(!RepoMap.run(&c, json!({"budget_tokens":8001})).await.ok);
    assert!(!RepoMap.run(&c, json!({"focus":["../outside"]})).await.ok);
    let tool = crate::tools::builtin().into_iter().find(|t| t.name() == "repo_map").unwrap();
    assert_eq!(tool.access(), Access::Read);
    assert_eq!(tool.schema()["properties"]["budget_tokens"]["default"], 2000);
    assert_eq!(tool.schema()["properties"]["budget_tokens"]["maximum"], 8000);
    assert!(crate::prompt::main_prompt(d.path()).contains("Use repo_map first on an unfamiliar repository"));
    assert!(text(&tool.run(&c, json!({})).await).starts_with(FRAME));
}

#[tokio::test(flavor = "current_thread")]
async fn runtime_timer_stays_responsive_during_large_map() {
    let d = repo();
    let content = "// lexical words in a comment\n".repeat(4500);
    for i in 0..64 { put(d.path(), &format!("file{i:03}.ts"), content.as_bytes()); }
    let (c, _rx) = ctx(d.path());
    let mapping = load(&c, Limits::default(), false);
    tokio::pin!(mapping);
    let mut timer = tokio::time::interval(Duration::from_millis(5));
    timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last = Instant::now();
    let mut worst = Duration::ZERO;
    let mut ticks = 0;
    loop {
        tokio::select! {
            result = &mut mapping => { assert!(!result.unwrap().partial); break; }
            _ = timer.tick() => {
                worst = worst.max(last.elapsed()); last = Instant::now(); ticks += 1;
            }
        }
    }
    worst = worst.max(last.elapsed());
    assert!(ticks > 2 && worst < Duration::from_millis(150), "timer stalled during map: {worst:?}, {ticks} ticks");
}

#[tokio::test]
async fn long_tracked_extensions_do_not_abort_or_enter_the_map() {
    let d = repo();
    for i in 0..12 { put(d.path(), &format!("a{i:02}.ts"), b"export function safe() {}\n"); }
    // A valid 255-byte filename whose snapshot prefix would exceed NAME_MAX.
    let long = format!("z.{}", "x".repeat(253));
    put(d.path(), &long, b"unsupported\n");
    assert!(std::process::Command::new("git").current_dir(d.path()).args(["add", "."]).status().unwrap().success());
    // Git can track a 300-character extension even though Linux cannot materialize it.
    let impossible = format!("z.{}", "x".repeat(300));
    let output = std::process::Command::new("git").current_dir(d.path()).args(["hash-object", "-w", "--stdin"]).output().unwrap();
    assert!(output.status.success());
    let oid = String::from_utf8(output.stdout).unwrap();
    assert!(std::process::Command::new("git").current_dir(d.path()).args(["update-index", "--add", "--cacheinfo", "100644", oid.trim(), &impossible]).status().unwrap().success());
    let (c, _rx) = ctx(d.path());
    let result = load(&c, Limits::default(), false).await;
    assert!(result.is_ok(), "unsupported extension must not abort the map");
    let m = result.unwrap();
    assert_eq!(m.files.len(), 12);
    assert!(m.skipped >= 2);
    assert!(!m.partial);
}

#[tokio::test]
async fn tracked_edits_invalidate_cache_and_unchanged_tree_hits_it() {
    let d = repo();
    put(d.path(), "a.ts", b"export function original() {}\n");
    assert!(std::process::Command::new("git").current_dir(d.path()).args(["add", "."]).status().unwrap().success());
    assert!(std::process::Command::new("git").current_dir(d.path()).args(["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--quiet", "--no-gpg-sign", "-m", "fixture"]).status().unwrap().success());
    let (c, _rx) = ctx(d.path());
    let first = load(&c, Limits::default(), true).await.unwrap();
    let cache = d.path().join(".git/gond-agent/repo-map.json");
    let modified = fs::metadata(&cache).unwrap_or_else(|e| panic!("cache unavailable: {e}; map:\n{}", render(&first, 2000, &[]))).modified().unwrap();
    // A cache hit bypasses even a zero construction budget and leaves the file untouched.
    let hit = load(&c, Limits { wall: Duration::ZERO, ..Limits::default() }, true).await.unwrap();
    assert_eq!(render(&first, 2000, &[]), render(&hit, 2000, &[]));
    assert_eq!(fs::metadata(&cache).unwrap().modified().unwrap(), modified);
    for name in ["edited", "edited_again"] {
        put(d.path(), "a.ts", format!("export function {name}() {{}}\n").as_bytes());
        let m = load(&c, Limits::default(), true).await.unwrap();
        assert!(m.files[0].symbols.iter().any(|s| s.name == name), "edit {name} not reflected in cached map");
    }
    put(d.path(), "new.ts", b"export function added() {}\n");
    assert!(render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]).contains("added"));
    put(d.path(), "new.ts", b"export function changed_untracked() {}\n");
    assert!(render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]).contains("changed_untracked"));
}

#[test]
fn snapshot_write_failure_skips_file_and_continues() {
    let d = repo();
    put(d.path(), "a.ts", b"export function skipped() {}\n");
    put(d.path(), "b.rs", b"pub fn kept() {}\n");
    let scratch = Scratch::new().unwrap();
    // A directory at the destination makes write fail even when the process owns the scratch dir.
    fs::create_dir(scratch.0.join("0.ts")).unwrap();
    let mut scan = Scan { map: Map::default(), scratch, snapshots: vec![], remaining: 1024, scanned: 0 };
    scan.listing(d.path(), b"a.ts\0b.rs\0", Limits::default(), Instant::now(), &CancellationToken::new());
    assert_eq!(scan.map.skipped, 1);
    assert_eq!(scan.map.files.len(), 1);
    assert_eq!(scan.map.files[0].path, "b.rs");
    assert_eq!(scan.snapshots[0].file_name().unwrap(), "0.rs");
}

#[tokio::test]
async fn status_filters_never_execute_repository_code() {
    for scope in ["local", "include", "worktree", "worktree-include"] {
        let included = scope.contains("include");
        let worktree = scope.starts_with("worktree");
        let d = repo();
        put(d.path(), "a.ts", b"export function original() {}\n");
        assert!(std::process::Command::new("git").current_dir(d.path()).args(["add", "."]).status().unwrap().success());
        let (c, _rx) = ctx(d.path());
        load(&c, Limits::default(), true).await.unwrap();
        let cache = d.path().join(".git/gond-agent/repo-map.json");
        let before = fs::read(&cache).unwrap();
        put(d.path(), ".gitattributes", b"*.ts filter=hostile\n");
        let config_dir = tempfile::tempdir().unwrap();
        if worktree {
            assert!(std::process::Command::new("git").current_dir(d.path()).args(["config", "extensions.worktreeConfig", "true"]).status().unwrap().success());
        }
        let config = if included { config_dir.path().join("filters") }
            else { d.path().join(if worktree { ".git/config.worktree" } else { ".git/config" }) };
        for (key, value) in [("filter.hostile.clean", "touch FILTER_EXECUTED; cat"), ("filter.hostile.required", "true")] {
            assert!(std::process::Command::new("git").args(["config", "--file"]).arg(&config).args([key, value]).status().unwrap().success());
        }
        if included {
            assert!(std::process::Command::new("git").current_dir(d.path()).args(["config", if worktree { "--worktree" } else { "--local" }, "include.path"]).arg(&config).status().unwrap().success());
        }
        put(d.path(), "a.ts", b"export function modified() {}\n");
        let map = load(&c, Limits::default(), true).await.unwrap();
        let output = render(&map, 2000, &[]);
        assert!(output.contains("modified"));
        assert!(!d.path().join("FILTER_EXECUTED").exists(), "status invoked a clean filter (scope={scope})");
        assert!(map.worktree.is_empty(), "unsafe status must bypass caching");
        assert!(output.contains("cache_bypass=\"repository-local filter configured\""), "missing bypass diagnostic: {output}");
        assert_eq!(fs::read(&cache).unwrap(), before, "unsafe status must not replace the old cache");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn host_git_filters_neither_execute_nor_disable_cache() {
    const FIXTURE: &str = "REPO_MAP_HOST_CONFIG_FIXTURE";
    if let Some(root) = std::env::var_os(FIXTURE) {
        let root = PathBuf::from(root);
        let (c, _rx) = ctx(&root);
        // Without config isolation, refreshing this dirty tracked file could invoke a filter.
        put(&root, "a.ts", b"export function modified() {}\n");
        let first = load(&c, Limits::default(), true).await.unwrap();
        let cache = root.join(".git/gond-agent/repo-map.json");
        assert!(!root.join("HOST_FILTER_EXECUTED").exists(), "host filter executed");
        assert!(cache.exists(), "host filter blocked caching; fingerprint={:?}; map:\n{}", first.worktree, render(&first, 2000, &[]));
        assert!(!first.partial && !first.worktree.is_empty());
        assert!(render(&first, 2000, &[]).contains("modified"));
        let modified = fs::metadata(&cache).unwrap().modified().unwrap();
        let hit = load(&c, Limits { wall: Duration::ZERO, ..Limits::default() }, true).await.unwrap();
        assert_eq!(render(&first, 2000, &[]), render(&hit, 2000, &[]), "unchanged tree must hit the cache");
        assert_eq!(fs::metadata(&cache).unwrap().modified().unwrap(), modified);
        assert!(!root.join("HOST_FILTER_EXECUTED").exists(), "host filter executed on cache hit");
        return;
    }
    let executable = std::env::current_exe().unwrap();
    let mut failures = vec![];
    // Isolated child environments avoid mutating process-global HOME/config during parallel tests.
    for source in ["explicit-global", "home", "home-include", "xdg", "system", "environment-count", "environment-parameters"] {
        let d = repo();
        put(d.path(), "a.ts", b"export function original() {}\n");
        assert!(std::process::Command::new("git").current_dir(d.path()).args(["add", "."]).status().unwrap().success());
        put(d.path(), ".gitattributes", b"*.ts filter=x\n");
        let host = tempfile::tempdir().unwrap();
        let config = match source {
            "home" | "home-include" => "home/.gitconfig",
            "xdg" => "xdg/git/config",
            _ => "filters.gitconfig",
        };
        put(host.path(), config, b"[filter \"x\"]\n\tclean = touch HOST_FILTER_EXECUTED; cat\n\trequired = true\n");
        fs::create_dir_all(host.path().join("home")).unwrap();
        fs::create_dir_all(host.path().join("xdg")).unwrap();
        if source == "home-include" {
            // Explicit includes still expand ~/; the Git child's HOME must be private/empty.
            assert!(std::process::Command::new("git").current_dir(d.path()).args(["config", "include.path", "~/.gitconfig"]).status().unwrap().success());
        }
        let mut child = std::process::Command::new(&executable);
        child.args(["--exact", "tools::repo_map::tests::host_git_filters_neither_execute_nor_disable_cache", "--nocapture", "--test-threads=1"])
            .env(FIXTURE, d.path()).env("HOME", host.path().join("home")).env("XDG_CONFIG_HOME", host.path().join("xdg"))
            .env_remove("GIT_CONFIG_NOSYSTEM").env_remove("GIT_CONFIG_GLOBAL").env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env_remove("GIT_CONFIG").env_remove("GIT_CONFIG_COUNT").env_remove("GIT_CONFIG_PARAMETERS");
        if source == "explicit-global" { child.env("GIT_CONFIG_GLOBAL", host.path().join(config)); }
        if source == "system" { child.env("GIT_CONFIG_SYSTEM", host.path().join(config)); }
        if source == "environment-count" {
            child.env("GIT_CONFIG_COUNT", "1").env("GIT_CONFIG_KEY_0", "filter.x.clean").env("GIT_CONFIG_VALUE_0", "touch HOST_FILTER_EXECUTED; cat");
        }
        if source == "environment-parameters" { child.env("GIT_CONFIG_PARAMETERS", "'filter.x.clean=touch HOST_FILTER_EXECUTED; cat'"); }
        let result = child.output().unwrap();
        if !result.status.success() {
            failures.push(format!("{source}:\n{}\n{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr)));
        }
    }
    assert!(failures.is_empty(), "host Git config regressions:\n{}", failures.join("\n"));
}

#[cfg(unix)]
#[tokio::test]
async fn unavailable_or_incompatible_ctags_errors_without_caching() {
    const FIXTURE: &str = "REPO_MAP_CTAGS_DEPENDENCY_FIXTURE";
    if let Some(root) = std::env::var_os(FIXTURE) {
        let root = PathBuf::from(root);
        let (c, _rx) = ctx(&root);
        let output = RepoMap.run(&c, json!({})).await;
        assert!(!output.ok, "unavailable symbol extraction must be a tool error, not an empty successful map");
        let message = text(&output);
        assert!(message.contains("Universal Ctags") && message.contains("JSON") && message.contains("unavailable"), "unclear dependency error: {message}");
        assert!(!root.join(".git/gond-agent/repo-map.json").exists(), "unavailable extraction must never populate the cache");
        return;
    }
    use std::os::unix::fs::{PermissionsExt, symlink};
    let executable = std::env::current_exe().unwrap();
    let git = std::env::split_paths(&std::env::var_os("PATH").unwrap()).map(|p| p.join("git")).find(|p| p.is_file()).expect("git is required for fixtures");
    for (mode, script) in [
        ("missing", None),
        ("not-universal", Some("#!/bin/sh\nprintf 'Exuberant Ctags 5.8\\n'\n")),
        ("no-json", Some("#!/bin/sh\ncase \"$2\" in --version) printf 'Universal Ctags 5.9.0\\n';; *) printf 'regex supports regex\\n';; esac\n")),
        ("json-rejected", Some("#!/bin/sh\ncase \"$2\" in --version) printf 'Universal Ctags 5.9.0\\n';; --list-features) printf 'json supports json output\\n';; *) exit 1;; esac\n")),
        ("invalid-json", Some("#!/bin/sh\ncase \"$2\" in --version) printf 'Universal Ctags 5.9.0\\n';; --list-features) printf 'json supports json output\\n';; *) printf 'not JSON tags\\n';; esac\n")),
    ] {
        let d = repo();
        put(d.path(), "a.ts", b"export function actual_symbol() {}\n");
        // Match the executable test filesystem, not /tmp (which may be mounted noexec).
        let bin = tempfile::tempdir_in(executable.parent().unwrap()).unwrap();
        symlink(&git, bin.path().join("git")).unwrap();
        if let Some(script) = script {
            put(bin.path(), "ctags", script.as_bytes());
            fs::set_permissions(bin.path().join("ctags"), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let result = std::process::Command::new(&executable)
            .args(["--exact", "tools::repo_map::tests::unavailable_or_incompatible_ctags_errors_without_caching", "--nocapture", "--test-threads=1"])
            .env(FIXTURE, d.path()).env("PATH", bin.path()).output().unwrap();
        assert!(result.status.success(), "{mode}: child regression failed:\n{}\n{}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
    }
}

// Offline benchmark bridge: invokes the shipped implementation, not a Python reimplementation.
#[tokio::test]
#[ignore = "invoked only by scripts/repo-map-benchmark.py with private fixture paths"]
async fn history_proxy_maps() {
    let input = std::env::var("REPO_MAP_BENCH_INPUT").expect("benchmark manifest");
    let output = std::env::var("REPO_MAP_BENCH_OUTPUT").expect("benchmark result path");
    let paths: Vec<String> = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    let mut results = vec![];
    for path in paths {
        let m = build(Path::new(&path)).await;
        assert!(!m.partial, "benchmark fixture exceeded normal tool bounds");
        results.push(render(&m, 2000, &[]));
    }
    fs::write(output, serde_json::to_vec(&results).unwrap()).unwrap();
}
