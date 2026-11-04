#!/usr/bin/env python3
"""Real compiled worker, local model endpoint and real Chromium image smoke."""
import base64
import http.server
import io
import json
import os
import pathlib
import secrets
import subprocess
import tempfile
import threading

from PIL import Image


def main():
    worker = os.environ.get("GOND_IMAGE_WORKER", "/usr/local/bin/gond-agent-worker")
    relay_token = secrets.token_urlsafe(32)
    with tempfile.TemporaryDirectory(prefix="gond-images-") as tmp:
        root = pathlib.Path(tmp)
        source = io.BytesIO()
        Image.new("RGB", (6000, 4000), (40, 90, 160)).save(source, "PNG")
        requests = []
        failures = []

        class Server(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def authenticate(self):
                try:
                    assert self.headers.get("Authorization") == f"Bearer {relay_token}", "Missing or invalid relay authorization"
                    assert "Origin" not in self.headers, "Unexpected relay Origin header"
                except AssertionError as error:
                    failures.append(str(error))
                    self.send_error(401, "Unauthorized")
                    return False
                return True

            def do_GET(self):
                if self.path == "/v1/models" and not self.authenticate():
                    return
                data = (json.dumps({"models": [{"id": "fixture", "context_window": 100000}]}).encode()
                        if self.path == "/v1/models" else b"<button onclick=\"this.textContent='Saved'\">Save</button>")
                self.send_response(200)
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                if not self.authenticate():
                    return
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                index = len(requests)
                requests.append(request)
                try:
                    if index == 0:
                        images = [b for m in request["messages"] for b in m["content"] if b["type"] == "image"]
                        assert len(images) == 1
                        check(images[0], "attachment 6000x4000")
                    else:
                        images = [p for m in request["messages"] for b in m["content"]
                                  if b["type"] == "tool_result" for p in b["content"] if p["type"] == "image"]
                        assert len(images) == 2, request
                        for image, label in zip(images, ["Chromium wide", "Chromium phone"]):
                            check(image, label)
                except Exception as error:
                    failures.append(str(error))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def event(name, data):
                    self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())

                event("response.start", {"id": "r", "model": "fixture"})
                if index == 0:
                    event("block.start", {"index": 0, "type": "tool_call", "id": "browser", "name": "browser"})
                    event("block.end", {"index": 0, "input": {
                        "url": f"http://127.0.0.1:{self.server.server_port}/page",
                        "script": "await page.getByRole('button').click(); await expect(page.getByRole('button')).toHaveText('Saved');"}})
                else:
                    event("block.start", {"index": 0, "type": "text"})
                    event("block.delta", {"index": 0, "text": "Done."})
                    event("block.end", {"index": 0})
                event("response.end", {"stop_reason": "tool_use" if index == 0 else "end_turn", "usage": {"input_uncached": 100, "output": 10, "cache_read": 0, "cache_write": 0}})

        def check(part, label):
            data = base64.b64decode(part["data"], validate=True)
            with Image.open(io.BytesIO(data)) as image:
                assert max(image.size) <= 1568, image.size
                assert len(data) <= 1024 * 1024, len(data)
                assert getattr(image, "n_frames", 1) == 1
                print(f"{label}: {image.width}x{image.height}, {len(data)} bytes, {part['media_type']}", flush=True)

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Server)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {**os.environ, "GOND_AGENT_API_URL": f"http://127.0.0.1:{server.server_port}",
               "GOND_AGENT_RELAY_TOKEN": relay_token, "GOND_AGENT_MODEL": "fixture", "GOND_AGENT_HOME": str(root / "home")}
        message = {"type": "user", "text": "Inspect attached image and browser fixture", "images": [
            {"media_type": "image/png", "data": base64.b64encode(source.getvalue()).decode()}]}
        try:
            proc = subprocess.run([worker], input=json.dumps(message) + "\n", text=True,
                                  capture_output=True, cwd=root, env=env, timeout=180)
            assert relay_token not in proc.stdout, "Relay token leaked to worker stdout"
            assert relay_token not in proc.stderr, "Relay token leaked to worker stderr"
            assert proc.returncode == 0, proc.stderr
            events = [json.loads(line) for line in proc.stdout.splitlines()]
            assert not [e for e in events if e["type"] == "error" or (e["type"] == "tool.end" and not e["ok"])], proc.stdout
            assert len(requests) == 2, (len(requests), proc.stdout, proc.stderr, failures)
            assert not failures, failures
            assert any(e["type"] == "turn.end" and e["stop_reason"] == "end_turn" for e in events)
            print("Image smoke passed: compiled worker -> fake model; attachment + both real Chromium viewports within caps")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
