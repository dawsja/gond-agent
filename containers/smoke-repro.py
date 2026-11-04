#!/usr/bin/env python3
"""Real JSONL worker, local fake model, real Vitest/Cargo, API PR section.

No GitHub/Docker or external model is used. Temporary fixture-only identities;
worker-recorded evidence is transparency, not independent proof.
"""
import http.server
import importlib.util
import json
import os
import pathlib
import secrets
import subprocess
import tempfile
import threading

REPO = pathlib.Path(__file__).resolve().parents[1]
WORKER = REPO / "runner/target/debug/gond-agent-worker"


def fixture(runner):
    with tempfile.TemporaryDirectory(prefix="gond-repro-smoke-") as tmp:
        root = pathlib.Path(tmp)
        env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN") and not k.startswith("GOND_AGENT_")}
        git_env = {**env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                   "GIT_AUTHOR_NAME": "fixture", "GIT_AUTHOR_EMAIL": "fixture@example.test",
                   "GIT_COMMITTER_NAME": "fixture", "GIT_COMMITTER_EMAIL": "fixture@example.test"}

        def git(*args):
            return subprocess.check_output(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", *args], cwd=root, env=git_env, stderr=subprocess.PIPE).decode().strip()

        git("init", "-q", "-b", "run")
        (root / ".gitignore").write_text("node_modules\ntarget/\n")
        if runner == "vitest":
            (root / "package.json").write_text('{"private":true,"scripts":{"test":"vitest run"}}')
            (root / "source.js").write_text("module.exports = 1;\n")
            (root / "node_modules").symlink_to(REPO / "api/node_modules", target_is_directory=True)
            path = "regression.test.js"
            test = "import {test,expect} from 'vitest'; import value from './source.js'; test('returns two',()=>expect(value).toBe(2));\n"
            fix = "printf 'module.exports = 2;\\n' > source.js"
            command = "npm test"
        else:
            (root / "Cargo.toml").write_text('[package]\nname="tiny_repro"\nversion="0.1.0"\nedition="2024"\n[lib]\npath="lib.rs"\n')
            (root / "lib.rs").write_text("pub fn value() -> u32 { 1 }\n")
            subprocess.run(["cargo", "generate-lockfile"], cwd=root, env=env, check=True, capture_output=True, timeout=30)
            path = "tests/regression.rs"
            test = "#[test]\nfn returns_two() { assert_eq!(tiny_repro::value(), 2); }\n"
            fix = "printf 'pub fn value() -> u32 { 2 }\\n' > lib.rs"
            command = "cargo test --locked"
        git("add", "--all")
        git("commit", "-qm", "fixture base")
        base = git("rev-parse", "HEAD")
        steps = [
            ("declare_task", {"kind": "bug", "repro_plan": "new assertion, red, fix, matching green"}),
            ("write", {"path": path, "content": test}),
            ("run_checks", {"repro": "red", "test_files": [path]}),
            ("bash", {"command": fix}),
            ("run_checks", {"repro": "green", "test_files": [path]}),
            ("run_checks", {"command": command}),
        ]
        key, token = secrets.token_hex(32), secrets.token_urlsafe(32)
        requests = []

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                assert self.headers.get("Authorization") == "Bearer " + token
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"models":[{"id":"fixture","context_window":100000}]}')

            def do_POST(self):
                assert self.headers.get("Authorization") == "Bearer " + token
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def event(kind, data):
                    self.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())

                event("response.start", {"id": "r", "model": "fixture"})
                index = len(requests) - 1
                if index < len(steps):
                    name, arguments = steps[index]
                    event("block.start", {"index": 0, "type": "tool_call", "id": f"c{index}", "name": name})
                    event("block.end", {"index": 0, "input": arguments})
                else:
                    event("block.start", {"index": 0, "type": "text"})
                    event("block.delta", {"index": 0, "text": "Regression fixed."})
                    event("block.end", {"index": 0})
                event("response.end", {"stop_reason": "tool_use" if index < len(steps) else "end_turn", "usage": {"input_uncached": 100, "output": 10, "cache_read": 0, "cache_write": 0}})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        worker_env = {**env, "GOND_AGENT_API_URL": f"http://127.0.0.1:{server.server_port}", "GOND_AGENT_RELAY_TOKEN": token,
                      "GOND_AGENT_MODEL": "fixture", "GOND_AGENT_HOME": str(root / ".home"), "GOND_AGENT_PLAN_NUDGE_LIMIT": "0"}
        spec = importlib.util.spec_from_file_location("smoke_controller", REPO / "containers/agent.py")
        controller = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(controller)
        controller.ROOT = str(root)
        process = subprocess.Popen([str(WORKER)], cwd=root, env=worker_env, text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        records = []
        try:
            def send(value):
                process.stdin.write(json.dumps(value) + "\n")
                process.stdin.flush()

            def until(kind):
                while True:
                    line = process.stdout.readline()
                    assert line, process.stderr.read()
                    e = json.loads(line)
                    if e["type"] == "evidence.recorded":
                        records.append(e["record"])
                        if e["record"]["kind"]["type"] == "repro_red":
                            r = e["record"]
                            stage = controller.dispatch({"method": "stage_repro", "title": "Fix regression", "identity": {"name": "fixture", "email": "fixture@example.test"},
                                "repro_stage": {"base": base, "tree": r["tree_hash_before"], "test_files": r["kind"]["test_files"]}})
                            assert stage["staged"], "Could not create local test commit after red"
                            assert git("rev-parse", "HEAD^{tree}") == r["tree_hash_before"]
                    if e["type"] == "tool.end" and e.get("output", "").startswith("Repro not recorded"):
                        print(e["output"], flush=True)
                    if e["type"] == kind:
                        return e

            send({"type": "init_evidence", "request_id": "key", "run_id": "run", "owner_id": "owner", "key": key})
            until("state.evidence_initialized")
            send({"type": "user", "text": "Fix the regression using a failing test first.", "images": []})
            until("turn.end")
            send({"type": "export_state", "request_id": "final", "run_id": "run", "owner_id": "owner"})
            final = until("state.exported")
            process.stdin.close()
            assert process.wait(timeout=30) == 0
            assert [r["kind"]["type"] for r in records] == ["repro_red", "repro_green", "check"], [(r["kind"], r["output_tail"]) for r in records]
            assert records[0]["kind"]["test_id"] == records[1]["kind"]["test_id"]
            assert len(requests) == 7, "Unexpected evidence gate continuation"
            red = records[0]
            snapshot = controller.snapshot_tree({"title": "Fix regression", "identity": {"name": "fixture", "email": "fixture@example.test"}})
            assert git("rev-parse", "HEAD^^") == base
            assert git("show", "-s", "--format=%s", "HEAD^") == "Add failing test for: Fix regression"
            print(f"{runner}: real worker red exit={red['exit_code']} -> fix -> green exit={records[1]['exit_code']}; seq={[r['seq'] for r in records]}", flush=True)
            print("Tests-only commit: " + git("diff", "--name-only", "HEAD^^", "HEAD^"), flush=True)
            js = f"""
import fs from 'node:fs';
import {{acceptEvidence,finishEvidence}} from {json.dumps(str(REPO / 'api/src/runs/evidence.ts'))};
import {{descriptionFor}} from {json.dumps(str(REPO / 'api/src/runs/publication.ts'))};
const p=JSON.parse(fs.readFileSync(0,'utf8')); const key=Buffer.from(p.key,'hex');
let state;
for(const r of p.records) {{ state=acceptEvidence(state,r,key,'run'); if(!state) throw new Error('Record admission failed'); }}
state=finishEvidence(state,{{state:p.final.state}},key);
state.publication_tree=p.tree; state.ui_required=false; state.staging='tests_first';
const body=descriptionFor({{title:'Fix regression',summary:{{final_reply:true,text:'Regression fixed.'}},status:'ready',evidence:state}});
if(!body.includes('Failing tail (assertion):') || !body.includes('Passing tail:') || body.includes('no failing repro recorded')) throw new Error('Missing regression sequence');
console.log(body);
"""
            result = subprocess.run([str(REPO / "api/node_modules/.bin/tsx"), "--eval", js], input=json.dumps({"key": key, "records": records, "final": final, "tree": git("rev-parse", f"{snapshot['head']}^{{tree}}")}), text=True, capture_output=True, env=env, timeout=30)
            assert result.returncode == 0, result.stderr
            assert key not in result.stdout and token not in result.stdout
            print(result.stdout, end="")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    fixture("vitest")
    fixture("cargo")
