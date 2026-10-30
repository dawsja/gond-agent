#!/usr/bin/env python3
"""Real worker/tool smoke test inside the worker container image."""
import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading


def main():
    with tempfile.TemporaryDirectory(prefix="gond-agent-smoke-") as tmp:
        root = pathlib.Path(tmp) / "repo"
        root.mkdir()
        (root / "index.html").write_text("<title>Worker fixture</title><button onclick=\"this.textContent='Saved'\">Save</button>")
        (root / "app.ts").write_text("export function greet() { return 'hello'; }\ngreet();\n")
        for args in [["init"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "fixture"]]:
            subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)

        class App(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write((root / "index.html").read_bytes())

            def log_message(self, *_):
                pass

        app = http.server.ThreadingHTTPServer(("127.0.0.1", 0), App)
        seen = []

        def call(id, name, input):
            return {"type": "tool_call", "id": id, "name": name, "input": input}

        workflow = [
            [call("outline", "symbols", {"action": "outline", "path": "app.ts"}),
             call("defs", "symbols", {"action": "definitions", "symbol": "greet"}),
             call("reads", "batch", {"calls": [{"tool": "read", "input": {"path": "app.ts"}}, {"tool": "symbols", "input": {"action": "references", "symbol": "greet"}}]})],
            [call("write", "write", {"path": "feature.txt", "content": "verified\n"})],
            [call("check", "bash", {"command": "test \"$(cat feature.txt)\" = verified"})],
            [call("ui", "browser", {"url": f"http://127.0.0.1:{app.server_port}", "script": "await page.getByRole('button', {name:'Save', exact:true}).click(); await expect(page.getByRole('button')).toHaveText('Saved');"})],
            [call("diff", "bash", {"command": "git diff --no-ext-diff; git ls-files --others --exclude-standard; cat feature.txt"})],
            [call("review", "finish_review", {"understanding": "Traced greet and the save flow", "design": "Keep the existing flow", "checks": ["check"], "diff_call_id": "diff", "review": "Inspected new file and both browser screenshots", "web_app": True})],
        ]

        class Model(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                data = json.dumps({"models": [{"id": "fixture", "context_window": 100000}]}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                index = len(seen)
                seen.append(request)
                blocks = workflow[index] if index < len(workflow) else [{"type": "text", "text": "Verified and self-reviewed."}]
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def event(name, data):
                    self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())

                event("response.start", {"id": "r", "model": "fixture"})
                for i, block in enumerate(blocks):
                    event("block.start", {"index": i, "type": block["type"], "id": block.get("id"), "name": block.get("name")})
                    if block["type"] == "text":
                        event("block.delta", {"index": i, "text": block["text"]})
                    event("block.end", {"index": i, "input": block.get("input")})
                event("response.end", {"stop_reason": "tool_use" if index < len(workflow) else "end_turn", "usage": {"input_uncached": 100, "output": 10, "cache_read": 0, "cache_write": 0}})

            def log_message(self, *_):
                pass

        model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
        for server in [app, model]:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {**os.environ, "GOND_AGENT_API_URL": f"http://127.0.0.1:{model.server_port}", "GOND_AGENT_MODEL": "fixture", "GOND_AGENT_HOME": str(pathlib.Path(tmp) / "home")}
        try:
            try:
                proc = subprocess.run(["/usr/local/bin/gond-agent-worker"], input='{"type":"user","text":"Implement and verify the feature"}\n', text=True, capture_output=True, cwd=root, env=env, timeout=180)
            except subprocess.TimeoutExpired as error:
                output = (error.stdout or b"").decode(errors="replace")
                events = [json.loads(line) for line in output.splitlines() if line.startswith("{")]
                progress = [{k: e[k] for k in ["type", "call_id", "name", "ok", "summary"] if k in e} for e in events[-12:]]
                raise RuntimeError(f"Worker smoke timed out after {len(seen)} model requests: {progress}") from None
            assert proc.returncode == 0, proc.stderr
            events = [json.loads(line) for line in proc.stdout.splitlines()]
            failures = [e for e in events if e["type"] == "error" or (e["type"] == "tool.end" and not e["ok"])]
            assert not failures, failures
            assert any(e["type"] == "turn.end" and e["stop_reason"] == "end_turn" for e in events)
            images = [e for e in events if e["type"] == "tool.images" and e["call_id"] == "ui"]
            assert len(images) == 1 and len(images[0]["images"]) == 2
            results = [b for req in seen for m in req["messages"] if m["role"] == "tool" for b in m["content"]]
            for id in ["outline", "defs"]:
                assert any(b["call_id"] == id and "greet" in json.dumps(b["content"]) for b in results), id
            assert all(t["name"] != "memory" for t in seen[0]["tools"])
            assert "go deep first" in seen[0]["system"]
            print("Worker smoke passed: symbols, batch, edits, checks, real browser images and completion gate")
        finally:
            app.shutdown()
            model.shutdown()


if __name__ == "__main__":
    main()
