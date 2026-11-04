use super::*;
use crate::tools::testutil::{ctx, text};

fn repo() -> tempfile::TempDir {
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
    assert!(out.contains("notes.xyzunknown\n"));
    assert_eq!(out, render(&build(d.path()).await, 2000, &[]));
}

#[tokio::test]
async fn cache_hit_head_version_corruption_oversize_and_private_atomic_file() {
    let d = repo();
    put(d.path(), "a.ts", b"export function original() {}\n");
    let (c, _rx) = ctx(d.path());
    let first = load(&c, Limits::default(), true).await.unwrap();
    let cache = d.path().join(".git/gond-agent/repo-map.json");
    assert!(cache.exists());
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; assert_eq!(fs::metadata(&cache).unwrap().permissions().mode() & 0o777, 0o600); }
    assert_eq!(fs::read_dir(cache.parent().unwrap()).unwrap().count(), 1, "no leftover temp file");
    put(d.path(), "a.ts", b"export function edited() {}\n");
    assert_eq!(render(&first, 2000, &[]), render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]), "same HEAD is a cache hit, including dirty edits");
    assert!(cache_read(d.path(), "a different head").is_none());
    let mut bad = serde_json::to_value(&first).unwrap(); bad["version"] = json!(VERSION + 1);
    fs::write(&cache, serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(cache_read(d.path(), &first.head).is_none());
    for content in [b"corrupt".as_slice(), b"{}".as_slice()] {
        fs::write(&cache, content).unwrap();
        assert!(render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]).contains("edited"));
    }
    File::create(&cache).unwrap().set_len(CACHE_MAX as u64 + 1).unwrap();
    assert!(cache_read(d.path(), &first.head).is_none());
    assert!(render(&load(&c, Limits::default(), true).await.unwrap(), 2000, &[]).contains("edited"));
    let mut new_head = first; new_head.head = "1111111111111111111111111111111111111111".into();
    cache_write(d.path(), &new_head);
    assert!(cache_read(d.path(), "unborn").is_none());
    assert!(cache_read(d.path(), &new_head.head).is_some());
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
    assert!(paths.contains(&"small.ts") && paths.contains(&"lossy.unknown"));
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
        assert!(cache_read(d.path(), &m.head).is_none());
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
