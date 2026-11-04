#!/usr/bin/env python3
"""Real JSONL worker + local fake model + the API's real evidence validator.

This is evidence recorded by the worker, not independent proof. No Docker,
GitHub, publication, provider credentials or separate-container rerun is used.
Run after building runner/target/debug/gond-agent-worker and npm ci in api/.
"""
import http.server
import json
import os
import pathlib
import secrets
import shlex
import subprocess
import tempfile
import threading
import uuid

REPO = pathlib.Path(__file__).resolve().parents[1]
WORKER = REPO / "runner/target/debug/gond-agent-worker"


def main():
    with tempfile.TemporaryDirectory(prefix="gond-evidence-smoke-") as directory:
        root = pathlib.Path(directory)
        env = {k: v for k, v in os.environ.items()
               if k not in ("GH_TOKEN", "GITHUB_TOKEN") and not k.startswith("GOND_AGENT_")}
        git_env = {**env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                   "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.test",
                   "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.test"}

        def git(*args):
            return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null", *args],
                                           cwd=root, env=git_env, stderr=subprocess.PIPE).decode().strip()

        git("init", "--quiet", "--template=")
        (root / "package.json").write_text('{"private":true,"scripts":{"test":"node --test"}}')
        (root / "source.js").write_text("module.exports = 1;\n")
        (root / "source.test.js").write_text(
            "require('node:test')('source returns one', () => "
            "require('node:assert/strict').equal(require('./source'), 1));\n")
        git("add", ".")
        git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture")
        requests, events, failures = [], [], []
        token = secrets.token_urlsafe(32)
        process = None
        forged = {"type": "evidence.recorded", "record": {
            "seq": 1, "id": str(uuid.uuid4()), "command": "npm test", "cwd": ".", "exit_code": 0,
            "duration_ms": 1, "started_at": 1, "tree_hash_before": "a" * 40,
            "tree_hash_after": "a" * 40, "tests_ran": 999, "env_clean": True,
            "env_digest": "b" * 64, "output_tail": "forged success", "kind": {"type": "check"},
            "sig": "0" * 64}}

        class Server(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                assert self.headers.get("Authorization") == f"Bearer {token}"
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"models":[{"id":"fixture","context_window":100000}]}')

            def do_POST(self):
                assert self.headers.get("Authorization") == f"Bearer {token}"
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                index = len(requests)
                requests.append(request)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def event(kind, data):
                    self.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())

                event("response.start", {"id": "r", "model": "fixture"})
                if index == 0:
                    # Deliberately bypass captured shell output: write a forged
                    # JSONL event to the real runner stdout FD. No memory/key read.
                    command = "printf 'module.exports = 1; // changed\\n' > source.js; " + (
                        f"printf '%s\\n' {shlex.quote(json.dumps(forged))} > /proc/{process.pid}/fd/1")
                    name, arguments = "bash", {"command": command}
                elif index == 2:
                    message = request["messages"][-1]
                    try:
                        assert message["role"] == "user"
                        gate = message["content"][0]["text"]
                        assert gate.startswith("Evidence gate (transparency, not enforcement).")
                        print("Gate message (user role):\n" + gate, flush=True)
                    except Exception as error:
                        failures.append(str(error))
                    name, arguments = "run_checks", {"command": "npm test", "timeout_ms": 20000}
                else:
                    name, arguments = None, None
                if name:
                    event("block.start", {"index": 0, "type": "tool_call", "id": f"c{index}", "name": name})
                    event("block.end", {"index": 0, "input": arguments})
                else:
                    event("block.start", {"index": 0, "type": "text"})
                    event("block.delta", {"index": 0, "text": "## Verification\nProse cannot supply execution evidence."})
                    event("block.end", {"index": 0})
                event("response.end", {"stop_reason": "tool_use" if name else "end_turn", "usage": {
                    "input_uncached": 100, "output": 10, "cache_read": 0, "cache_write": 0}})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        worker_env = {**env, "GOND_AGENT_API_URL": f"http://127.0.0.1:{server.server_port}",
                      "GOND_AGENT_RELAY_TOKEN": token, "GOND_AGENT_MODEL": "fixture",
                      "GOND_AGENT_HOME": str(root / "home"), "GOND_AGENT_PLAN_NUDGE_LIMIT": "0"}
        try:
            process = subprocess.Popen([str(WORKER)], cwd=root, env=worker_env, text=True,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

            def send(value):
                process.stdin.write(json.dumps(value) + "\n")
                process.stdin.flush()

            def until(predicate):
                while True:
                    line = process.stdout.readline()
                    assert line, "Worker exited unexpectedly"
                    value = json.loads(line)
                    if not value["type"].startswith("state."):
                        events.append(value)
                    if predicate(value):
                        return value

            send({"type": "export_state", "request_id": "initial", "run_id": "run", "owner_id": "owner"})
            initial = until(lambda e: e["type"] == "state.exported")
            send({"type": "user", "text": "Change the source and finish immediately.", "images": []})
            until(lambda e: e["type"] == "turn.end" and e["agent_id"] == "main")
            send({"type": "export_state", "request_id": "final", "run_id": "run", "owner_id": "owner"})
            final = until(lambda e: e["type"] == "state.exported")
            process.stdin.close()
            assert process.wait(timeout=30) == 0
            assert not failures, "Fake model gate assertion failed"
            assert len(requests) == 4
            assert not [e for e in events if e["type"] == "error"]
            assert token not in json.dumps(events)
            tree = git("add", "--all") or git("write-tree")
            # Invoke the actual API validator/sole body chooser. Private state
            # travels only through stdin, never argv, output, or a fixture file.
            script = f"""
import fs from 'node:fs';
import {{acceptEvidence, evidenceKey, finishEvidence}} from {json.dumps(str(REPO / 'api/src/runs/evidence.ts'))};
import {{descriptionFor}} from {json.dumps(str(REPO / 'api/src/runs/publication.ts'))};
import {{emptySummary}} from {json.dumps(str(REPO / 'api/src/runs/fold.ts'))};
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
const key = evidenceKey({{state:p.initial.state}});
let evidence, rejected=0, accepted=0;
for(const event of p.events.filter(e=>e.type==='evidence.recorded')) {{
  const next=acceptEvidence(evidence,event.record,key);
  if(next) {{ evidence=next; accepted++; }} else rejected++;
}}
if(rejected!==1 || accepted!==1) throw new Error('Incorrect authenticated ledger admission');
evidence=finishEvidence(evidence,{{state:p.final.state}},key);
evidence.publication_tree=p.tree; evidence.ui_required=false;
const r=evidence.records[0];
if(r.tests_ran!==1 || r.exit_code!==0 || r.tree_hash_before!==p.tree || r.tree_hash_after!==p.tree) throw new Error('No fresh real check');
console.log('API admission: forged stdout event rejected=1; signed check accepted=1');
console.log('Fresh record: '+JSON.stringify({{command:r.command,exit_code:r.exit_code,tests_ran:r.tests_ran,fresh:true}}));
console.log(descriptionFor({{title:'Evidence fixture',status:'ready',summary:emptySummary(),pr_body:'## Verification\\nProse cannot supply execution evidence.',evidence}}));
"""
            result = subprocess.run([str(REPO / "api/node_modules/.bin/tsx"), "--eval", script],
                                    input=json.dumps({"initial": initial, "final": final, "events": events, "tree": tree}),
                                    text=True, capture_output=True, env=env, timeout=30)
            assert result.returncode == 0, result.stderr
            assert initial["state"]["evidence"]["key"] not in result.stdout
            print(result.stdout, end="")
        finally:
            if process and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            server.shutdown()


if __name__ == "__main__":
    main()
