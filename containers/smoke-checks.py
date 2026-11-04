#!/usr/bin/env python3
"""Real worker run_checks environment/Chromium smoke; no persistent browser daemon.

Requires a freshly built runner/target/debug/gond-agent-worker and the worker
image's /opt/gond-agent-browser runtime, @playwright/test and Chromium install.
Uses only a local fake model and disposable Git fixture; no API/provider needed.
"""
import http.server
import json
import os
import pathlib
import queue
import secrets
import subprocess
import tempfile
import threading

REPO = pathlib.Path(__file__).resolve().parents[1]
WORKER = REPO / "runner/target/debug/gond-agent-worker"
IMAGE_VARS = {
    "NODE_PATH": "/opt/gond-agent-browser/node_modules",
    "PLAYWRIGHT_BROWSERS_PATH": "/opt/gond-agent-browser/browsers",
    "BUN_INSTALL": "/fixture/bun",
    "UV_TOOL_DIR": "/fixture/uv",
    "PYTHONUSERBASE": "/fixture/python",
}


def main():
    with tempfile.TemporaryDirectory(prefix="gond-checks-smoke-") as directory:
        root = pathlib.Path(directory)
        env = {k: v for k, v in os.environ.items()
               if k not in ("GH_TOKEN", "GITHUB_TOKEN") and not k.startswith("GOND_AGENT_")}
        git_env = {"PATH": env["PATH"], "HOME": str(root),
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                   "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.test",
                   "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.test"}

        def git(*args):
            subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=root,
                           env=git_env, check=True, capture_output=True, timeout=10)

        git("init", "--quiet", "--template=")
        (root / "package.json").write_text(json.dumps({
            "private": True, "scripts": {"test": "node --test environment.test.cjs"}}))
        (root / ".gitignore").write_text("background.txt\nhome/\n")
        (root / "sub").mkdir()
        (root / "sub/.keep").write_text("")
        # Never put secret values into tests, command arguments or output.
        (root / "probe.cjs").write_text("""
const assert = require('node:assert/strict');
const image = """ + json.dumps(IMAGE_VARS) + """;
exports.probe = function(inherited) {
  for (const name of Object.keys(process.env)) {
    assert.ok(!['GH_TOKEN', 'GITHUB_TOKEN'].includes(name) && !name.startsWith('GOND_AGENT_'), 'secret name inherited');
  }
  for (const [name, value] of Object.entries(image)) {
    if (inherited || ['UV_TOOL_DIR', 'PYTHONUSERBASE'].includes(name)) {
      assert.ok(process.env[name] === value, 'missing image variable: ' + name);
    } else assert.ok(!(name in process.env), 'non-allowlisted variable: ' + name);
  }
  for (const name of ['NODE_OPTIONS', 'PYTHONPATH', 'BASH_ENV']) {
    assert.ok((name in process.env) === inherited, 'wrong injection environment: ' + name);
  }
};
""")
        (root / "environment.test.cjs").write_text("""
const inherited = 'BUN_INSTALL' in process.env;
require('node:test')(inherited ? 'environment-inherited' : 'environment-clean', () => require('./probe.cjs').probe(inherited));
""")
        (root / "browser.test.cjs").write_text("""
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {chromium} = require('@playwright/test'); // Must resolve through image NODE_PATH.
test('real Chromium from run_checks', {timeout: 30000}, async () => {
  require('./probe.cjs').probe(true);
  const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
  try {
    const page = await browser.newPage();
    await page.setContent('<button>Run checks</button><output></output>');
    await page.locator('button').evaluate(button => button.onclick = () => document.querySelector('output').textContent = 'Chromium works');
    await page.getByRole('button', {name:'Run checks'}).click();
    assert.equal(await page.locator('output').textContent(), 'Chromium works');
    assert.match(browser.version(), /^\\d+\\./);
  } finally { await browser.close(); }
});
""")
        (root / "background.test.cjs").write_text("""
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
test('background check retains image environment without secrets', {timeout:10000}, async () => {
  require('./probe.cjs').probe(true);
  for (let attempt=0; attempt<100; attempt++) {
    const text = await fs.readFile('background.txt', 'utf8').catch(() => '');
    if (text.includes('# fail 0')) { assert.ok(text.includes('environment-inherited')); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('background check did not pass');
});
""")
        git("add", ".")
        git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture")
        actions = [
            ("browser-check", {"command": "node --test browser.test.cjs", "timeout_ms": 45000,
                               "env_clean": True}),  # Input cannot forge eligibility.
            ("wrong-cwd", {"command": "npm test", "cwd": "sub", "timeout_ms": 15000}),
            ("background", {"command": "node --test --test-reporter=tap environment.test.cjs > background.txt",
                            "run_in_background": True}),
            ("background-result", {"command": "node --test background.test.cjs", "timeout_ms": 15000}),
            ("eligible", {"command": "npm test", "timeout_ms": 15000}),
        ]
        requests, events, stderr = [], [], []
        token, sentinel, evidence_key = secrets.token_urlsafe(32), secrets.token_hex(24), secrets.token_hex(32)

        class Server(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                assert self.headers.get("Authorization") == f"Bearer {token}", "missing relay authentication"
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"models":[{"id":"fixture","context_window":100000}]}')

            def do_POST(self):
                assert self.headers.get("Authorization") == f"Bearer {token}", "missing relay authentication"
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                index = len(requests) - 1
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def event(kind, data):
                    self.wfile.write(f"event: {kind}\ndata: {json.dumps(data)}\n\n".encode())

                event("response.start", {"id": "r", "model": "fixture"})
                if index < len(actions):
                    call_id, arguments = actions[index]
                    event("block.start", {"index": 0, "type": "tool_call", "id": call_id, "name": "run_checks"})
                    event("block.end", {"index": 0, "input": arguments})
                else:
                    event("block.start", {"index": 0, "type": "text"})
                    event("block.delta", {"index": 0, "text": "Finished environment smoke."})
                    event("block.end", {"index": 0})
                event("response.end", {"stop_reason": "tool_use" if index < len(actions) else "end_turn",
                                       "usage": {"input_uncached": 100, "output": 10, "cache_read": 0, "cache_write": 0}})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        worker_env = {**env, **IMAGE_VARS, "NODE_OPTIONS": "--trace-warnings",
                      "PYTHONPATH": "/fixture/injection", "BASH_ENV": "/fixture/nonexistent",
                      "GH_TOKEN": sentinel, "GITHUB_TOKEN": sentinel,
                      "GOND_AGENT_TOKEN": sentinel, "GOND_AGENT_OTHER_SECRET": sentinel,
                      "GOND_AGENT_RELAY_TOKEN": token, "GOND_AGENT_MODEL": "fixture",
                      "GOND_AGENT_API_URL": f"http://127.0.0.1:{server.server_port}",
                      "GOND_AGENT_HOME": str(root / "home"), "GOND_AGENT_PLAN_NUDGE_LIMIT": "0"}
        process = None
        try:
            process = subprocess.Popen([str(WORKER)], cwd=root, env=worker_env, text=True,
                                       stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            lines = queue.Queue()

            def read_stdout():
                for line in process.stdout:
                    lines.put(line)
                lines.put(None)

            def read_stderr():
                stderr.extend(process.stderr.readlines())

            threading.Thread(target=read_stdout, daemon=True).start()
            threading.Thread(target=read_stderr, daemon=True).start()

            def send(value):
                process.stdin.write(json.dumps(value) + "\n")
                process.stdin.flush()

            def until(kind):
                while True:
                    line = lines.get(timeout=75)
                    assert line is not None, "worker exited unexpectedly"
                    assert sentinel not in line and token not in line and evidence_key not in line, "secret leaked"
                    value = json.loads(line)
                    events.append(value)
                    if value["type"] == kind:
                        return value

            send({"type": "init_evidence", "request_id": "initialize", "run_id": "run",
                  "owner_id": "owner", "key": evidence_key})
            until("state.evidence_initialized")
            send({"type": "user", "text": "Execute the environment smoke checks.", "images": []})
            until("turn.end")
            process.stdin.close()
            assert process.wait(timeout=10) == 0, "worker failed"
            assert len(requests) == len(actions) + 1, (
                f"unexpected gate/model requests: {len(requests)}; "
                f"tool outcomes: {[(e['call_id'], e['ok']) for e in events if e['type'] == 'tool.end']}; "
                f"error events: {sum(e['type'] == 'error' for e in events)}")
            assert not any(e["type"] == "error" for e in events), "worker error event"
            endings = {e["call_id"]: e for e in events if e["type"] == "tool.end"}
            logs = json.dumps(events) + json.dumps(requests) + "".join(stderr)
            assert sentinel not in logs and token not in logs and evidence_key not in logs, "fixture secret leaked"
            for call_id, _ in actions:
                assert call_id in endings and endings[call_id]["ok"], f"check failed: {call_id}: {endings.get(call_id)}"
            records = [e["record"] for e in events if e["type"] == "evidence.recorded"]
            assert len(records) == 1, "noneligible/background check produced evidence"
            record = records[0]
            assert record["command"] == "npm test" and record["cwd"] == ".", "wrong eligible check"
            assert record["env_clean"] and record["tests_ran"] == 1 and record["exit_code"] == 0, "bad clean record"
            assert "environment-clean" in record["output_tail"], "eligible check was not clean"
            assert "environment-inherited" in endings["wrong-cwd"]["output"], "cwd mismatch selected clean environment"
            # Inspect actual tool results sent back to the fake model, not prose.
            results = {}
            for request in requests:
                for message in request["messages"]:
                    for block in message.get("content", []):
                        if block.get("type") == "tool_result":
                            results[block["call_id"]] = block
            for call_id in ("browser-check", "background-result"):
                result = json.loads(results[call_id]["content"][0]["text"])
                assert result["exit_code"] == 0 and result["tests_ran"] == 1, f"no real test count: {call_id}"
            print("run_checks Chromium: exit_code=0 tests_ran=1 (image NODE_PATH/PLAYWRIGHT_BROWSERS_PATH)")
            print("Noneligible/cwd/background: image variables inherited; GitHub/Gond/relay secrets excluded")
            print("Eligible npm test: env_clean=true tests_ran=1; injection variables stripped; one signed record")
        finally:
            if process and process.poll() is None:
                process.kill()
                process.wait(timeout=5)
            server.shutdown()


if __name__ == "__main__":
    main()
