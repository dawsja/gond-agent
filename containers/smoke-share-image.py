#!/usr/bin/env python3
"""Compiled worker -> fake model -> real API persistence -> real transcript fold.

Run after cargo build and npm ci in api/web. No Docker, GitHub or Chromium needed.
"""
import base64
import http.server
import json
import os
import pathlib
import secrets
import subprocess
import tempfile
import threading
import struct
import zlib


def main():
    repo = pathlib.Path(__file__).resolve().parents[1]
    worker = os.environ.get("GOND_IMAGE_WORKER", str(repo / "runner/target/debug/gond-agent-worker"))
    token = secrets.token_urlsafe(32)
    requests, failures = [], []
    with tempfile.TemporaryDirectory(prefix="gond-share-", dir="/tmp") as tmp:
        root = pathlib.Path(tmp)
        source = root / "desktop.png"
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        pixels = (b"\x00" + bytes((40, 90, 160)) * 2400) * 1500
        source.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2400, 1500, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))

        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                assert self.headers.get("Authorization") == f"Bearer {token}"
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"models": [{"id": "fixture", "context_window": 100000}]}).encode())

            def do_POST(self):
                assert self.headers.get("Authorization") == f"Bearer {token}"
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                index = len(requests)
                requests.append(request)
                try:
                    assert any(t["name"] == "share_image" for t in request["tools"])
                    if index:
                        results = [b for m in request["messages"] for b in m["content"] if b["type"] == "tool_result"]
                        assert len(results) == 1
                        assert not results[0].get("is_error")
                        assert all(p["type"] == "text" for p in results[0]["content"])
                        assert "untrusted data" in results[0]["content"][0]["text"]
                except Exception as error:
                    failures.append(repr(error))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def event(name, data):
                    self.wfile.write(f"event: {name}\ndata: {json.dumps(data)}\n\n".encode())

                event("response.start", {"id": "r", "model": "fixture"})
                if index == 0:
                    event("block.start", {"index": 0, "type": "tool_call", "id": "share", "name": "share_image"})
                    event("block.end", {"index": 0, "input": {"path": str(source), "caption": "Desktop pagination"}})
                else:
                    event("block.start", {"index": 0, "type": "text"})
                    event("block.delta", {"index": 0, "text": "Desktop pagination is shown above."})
                    event("block.end", {"index": 0})
                event("response.end", {"stop_reason": "tool_use" if index == 0 else "end_turn", "usage": {"input_uncached": 100, "output": 10, "cache_read": 0, "cache_write": 0}})

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        env = {k: v for k, v in os.environ.items() if k not in ("GH_TOKEN", "GITHUB_TOKEN") and not k.startswith("GOND_AGENT_")}
        env.update(GOND_AGENT_API_URL=f"http://127.0.0.1:{server.server_port}", GOND_AGENT_RELAY_TOKEN=token,
                   GOND_AGENT_MODEL="fixture", GOND_AGENT_HOME=str(root / "home"), GOND_AGENT_EVIDENCE="off")
        try:
            proc = subprocess.run([worker], input=json.dumps({"type": "user", "text": "Show desktop pagination"}) + "\n", text=True, capture_output=True, cwd=root, env=env, timeout=120)
            assert token not in proc.stdout + proc.stderr
            assert proc.returncode == 0, proc.stderr
            events = [json.loads(line) for line in proc.stdout.splitlines()]
            assert not failures, failures
            assert len(requests) == 2, proc.stdout
            assert not [e for e in events if e["type"] == "error" or (e["type"] == "tool.end" and not e["ok"])], proc.stdout
            shared = [e for e in events if e["type"] == "image.shared"]
            assert len(shared) == 1
            assert not [e for e in events if e["type"] == "tool.images"]
            data = base64.b64decode(shared[0]["image"]["data"], validate=True)
            assert len(data) <= 1024 * 1024
            assert shared[0]["image"]["media_type"] in ("image/jpeg", "image/png")
            # The API bridge decodes these bytes with the existing sharp dependency
            # and checks dimensions, format and size after actual persistence.
            print("fake model: 2 requests; share_image result is text only; untrusted-content warning present", flush=True)
            event_file = root / "events.json"
            event_file.write_text(json.dumps(events))
            clean = {k: v for k, v in env.items() if not k.startswith("GOND_AGENT_")}
            subprocess.run(["npm", "exec", "--", "tsx", "test/fixtures/share-image-smoke.ts", str(event_file)], cwd=repo / "api", env=clean, check=True, timeout=60)
            print("Shared-image smoke passed: compiled worker -> fake model -> SQLite image ID -> transcript image card", flush=True)
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
