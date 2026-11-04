#!/usr/bin/env python3
"""Container control + loopback model relay. Only Docker's attached stdio reaches the host."""
import base64
import hmac
import http.server
import io
import json
import os
import pathlib
import queue
import secrets
import select
import socket
import time
import signal
import subprocess
import sys
import tarfile
import threading
import traceback
import uuid

ROOT = "/workspace/repo"
MAX_FRAME = 256 * 1024 * 1024
worker = None
relay_token = None
events = []
event_lock = threading.Lock()
worker_lock = threading.Lock()
output_lock = threading.Lock()
model_lock = threading.Lock()
models = {}


def emit(frame):
    with output_lock:
        sys.stdout.write(json.dumps(frame, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def command(args, timeout=120, env=None):
    result = subprocess.run(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=env)
    if result.returncode:
        print("Workspace command failed:", args[0], result.stderr.decode(errors="replace")[-1000:], file=sys.stderr)
        raise RuntimeError("The workspace command failed.")
    return result.stdout


def drain(stream, source=None):
    for line in stream:
        try:
            event = json.loads(line)
            with event_lock:
                if source is None or source is worker:
                    events.append(event)
        except ValueError:
            pass


def worker_env(req):
    """The built-in runner reaches models only through the loopback relay; no model credentials exist here."""
    if not relay_token:
        raise RuntimeError("The model relay is not ready.")
    return {**os.environ, "GOND_AGENT_RELAY_TOKEN": relay_token, "GOND_AGENT_API_URL": "http://127.0.0.1:8787", "GOND_AGENT_MODEL": req["model"], "GOND_AGENT_EFFORT": req.get("effort", "high"), "GOND_AGENT_HOME": "/tmp/gond-agent", "GOND_AGENT_INITIAL_PLAN": json.dumps(req.get("plan", [])),
            "GOND_AGENT_QUESTION_WAIT_MINUTES": str(req.get("question_wait_minutes", 240)),
            "GOND_AGENT_INTERACTIVE": "true" if req.get("interactive") is True else "false",
            "GOND_AGENT_PLAN_REMINDER_EVERY": str(req.get("plan_reminder_every", 6)), "GOND_AGENT_PLAN_NUDGE_LIMIT": str(req.get("plan_nudge_limit", 2))}


def dispatch(req):
    global worker, relay_token
    method = req["method"]
    if method == "ping":
        return {"ready": True}
    if method == "setup":
        with worker_lock:
            if worker and worker.poll() is None:
                raise RuntimeError("The worker is already running.")
            with tarfile.open(fileobj=io.BytesIO(base64.b64decode(req["archive"], validate=True)), mode="r:gz") as tar:
                tar.extractall(ROOT, filter="data")
        return True
    if method == "start":
        with worker_lock:
            if worker and worker.poll() is None:
                raise RuntimeError("The worker is already running.")
            relay_token = secrets.token_urlsafe(32)
            pathlib.Path(os.environ["TMPDIR"]).mkdir(parents=True, exist_ok=True)
            with open("/tmp/worker.log", "ab") as log:
                worker = subprocess.Popen(["/usr/local/bin/gond-agent-worker"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=log, text=True, bufsize=1, start_new_session=True, env=worker_env(req))
            threading.Thread(target=drain, args=(worker.stdout, worker), daemon=True).start()
        return True
    if method == "send":
        with worker_lock:
            if not worker or worker.poll() is not None:
                raise RuntimeError("The worker is not running.")
            worker.stdin.write(json.dumps(req["input"]) + "\n")
            worker.stdin.flush()
        return True
    if method == "events":
        after = req.get("after", 0)
        if not isinstance(after, int) or after < 0:
            raise RuntimeError("Invalid event cursor.")
        with event_lock:
            batch = []
            size = 0
            for event in events[after:after + 200]:
                length = len(json.dumps(event))
                if batch and size + length > 16 * 1024 * 1024:
                    break
                batch.append(event)
                size += length
        return {"events": batch, "alive": worker is not None and worker.poll() is None}
    if method == "snapshot":
        command(["git", "-c", "core.hooksPath=/dev/null", "add", "--all"])
        if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode:
            identity = req.get("identity", {})
            if any(not isinstance(identity.get(key), str) or not identity[key].strip() or any(c in identity[key] for c in "\r\n\0<>") for key in ("name", "email")):
                raise RuntimeError("A connected GitHub commit identity is required.")
            env = dict(os.environ)
            env.update({f"GIT_{role}_{key}": identity[field] for role in ("AUTHOR", "COMMITTER") for key, field in (("NAME", "name"), ("EMAIL", "email"))})
            command(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", req.get("title", "Changes")], env=env)
        command(["git", "bundle", "create", "/tmp/work.bundle", "HEAD"])
        return {"bundle": base64.b64encode(pathlib.Path("/tmp/work.bundle").read_bytes()).decode(), "head": command(["git", "rev-parse", "HEAD"]).decode().strip()}
    if method == "diff":
        return command(["git", "--no-pager", "diff", "--no-ext-diff", req["base"], "--"]).decode(errors="replace")[:2000000]
    raise RuntimeError("Unknown workspace method.")


def handle(req):
    try:
        response = {"id": req["id"], "result": dispatch(req)}
    except Exception as error:
        print("Workspace request failed:", req.get("method"), type(error).__name__, file=sys.stderr)
        traceback.print_exc()
        response = {"id": req.get("id"), "error": "The workspace request failed."}
    emit(response)


class ModelProxy(http.server.BaseHTTPRequestHandler):
    def parse_request(self):
        if not super().parse_request():
            return False
        # Check every method/path before routing, including unsupported endpoints.
        authorization = self.headers.get_all("Authorization", [])
        if not relay_token or len(authorization) != 1 or not hmac.compare_digest(
                authorization[0].encode("utf-8"), ("Bearer " + relay_token).encode("utf-8")):
            self.send_error(401, "Unauthorized")
            return False
        if self.headers.get_all("Origin") is not None or self.headers.get_all("Host", []) not in (
                ["127.0.0.1:8787"], ["localhost:8787"]):
            self.send_error(403)
            return False
        if self.command == "POST":
            content_types = self.headers.get_all("Content-Type", [])
            if len(content_types) != 1 or content_types[0].split(";", 1)[0].strip().lower() != "application/json":
                self.send_error(415)
                return False
        if self.command not in ("GET", "POST"):
            self.send_error(403)
            return False
        return True

    def relay(self):
        if (self.command, self.path) not in [("GET", "/v1/models"), ("POST", "/v1/responses"), ("POST", "/v1/search")]:
            self.send_error(403)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 0 or length > 96 * 1024 * 1024:
            self.send_error(413)
            return
        key = uuid.uuid4().hex
        replies = queue.Queue(maxsize=64)
        with model_lock:
            if len(models) >= 16:
                self.send_error(429)
                return
            models[key] = replies
        started = False
        try:
            body = self.rfile.read(length)
            emit({"model": {"id": key, "method": self.command, "path": self.path, "body": base64.b64encode(body).decode()}})
            deadline = time.monotonic() + 600
            while True:
                try:
                    frame = replies.get(timeout=0.2)
                except queue.Empty:
                    if time.monotonic() >= deadline:
                        break
                    readable, _, _ = select.select([self.connection], [], [], 0)
                    if readable and not self.connection.recv(1, socket.MSG_PEEK):
                        break
                    continue
                deadline = time.monotonic() + 600
                if "status" in frame and not started:
                    self.send_response(frame["status"])
                    self.send_header("Content-Type", frame.get("headers", {}).get("content-type", "application/json"))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    started = True
                if "chunk" in frame and started:
                    self.wfile.write(base64.b64decode(frame["chunk"], validate=True))
                    self.wfile.flush()
                if frame.get("end"):
                    break
        except (BrokenPipeError, ConnectionResetError, queue.Empty):
            pass
        finally:
            self.close_connection = True
            with model_lock:
                models.pop(key, None)
            emit({"model_cancel": key})

    do_GET = relay
    do_POST = relay

    def log_message(self, *_):
        pass


def shutdown():
    if worker and worker.poll() is None:
        try:
            os.killpg(worker.pid, signal.SIGKILL)
            worker.wait(timeout=5)
        except ProcessLookupError:
            pass
    with model_lock:
        for replies in models.values():
            try:
                replies.put_nowait({"end": True})
            except queue.Full:
                pass


def main():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 8787), ModelProxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_FRAME + 1)
            if not line:
                break
            if len(line) > MAX_FRAME or not line.endswith(b"\n"):
                raise RuntimeError("Control frame too large.")
            req = json.loads(line)
            if "model_id" in req:
                with model_lock:
                    replies = models.get(req["model_id"])
                if replies:
                    try:
                        replies.put(req, timeout=10)
                    except queue.Full:
                        raise RuntimeError("Model stream stalled.") from None
            else:
                threading.Thread(target=handle, args=(req,), daemon=True).start()
    finally:
        shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
