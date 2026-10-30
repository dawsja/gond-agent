#!/usr/bin/env python3
"""Container control + loopback model relay. Only Docker's attached stdio reaches the host."""
import base64
import http.server
import io
import json
import os
import pathlib
import queue
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


def command(args, timeout=120):
    result = subprocess.run(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
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


def dispatch(req):
    global worker
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
    if method == "cli_stop":
        if worker and worker.poll() is None:
            os.killpg(worker.pid, signal.SIGKILL)
            worker.wait(timeout=5)
        worker = None
        return True
    if method == "cli_state":
        root = pathlib.Path("/tmp/cli-home")
        credentials, sessions = {}, {}
        credential_paths = {".claude/.credentials.json", ".claude.json", ".codex/auth.json"}
        total = 0
        for path in root.rglob("*"):
            if path.is_symlink() or not path.is_file():
                continue
            relative = path.relative_to(root).as_posix()
            if relative not in credential_paths and not relative.startswith((".claude/projects/", ".codex/sessions/")):
                continue
            data = path.read_bytes()
            total += len(data)
            if total > 16 * 1024 * 1024:
                raise RuntimeError("Agent session state exceeds the storage limit.")
            (credentials if relative in credential_paths else sessions)[relative] = base64.b64encode(data).decode()
        session_file = pathlib.Path("/tmp/cli-session.json")
        return {"credentials": credentials, "files": sessions, "session": json.loads(session_file.read_text()).get("session") if session_file.exists() else None}
    if method == "cli_prepare":
        root = pathlib.Path("/tmp/cli-home")
        root.mkdir(mode=0o700, exist_ok=True)
        state = req.get("state", {})
        for relative, data in {**state.get("files", {}), **state.get("credentials", {})}.items():
            path = pathlib.PurePosixPath(relative)
            if path.is_absolute() or ".." in path.parts or not (relative in {".claude/.credentials.json", ".claude.json", ".codex/auth.json"} or relative.startswith((".claude/projects/", ".codex/sessions/"))):
                raise RuntimeError("Invalid agent state path.")
            target = root / relative
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(data, validate=True))
            target.chmod(0o600)
        if state.get("session"):
            pathlib.Path("/tmp/cli-session.json").write_text(json.dumps({"session": state["session"]}))
        config = {**req["config"], "session": state.get("session")}
        pathlib.Path("/tmp/cli-config.json").write_text(json.dumps(config))
        return True
    if method == "start":
        with worker_lock:
            if worker and worker.poll() is None:
                raise RuntimeError("The worker is already running.")
            with open("/tmp/worker.log", "ab") as log:
                worker = subprocess.Popen(["node", "/opt/gond-agent/cli.mjs"] if req.get("backend") else ["/usr/local/bin/gond-agent-worker"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                    stderr=log, text=True, bufsize=1, start_new_session=True,
                    env={**os.environ, "GOND_AGENT_API_URL": "http://127.0.0.1:8787", "GOND_AGENT_MODEL": req["model"], "GOND_AGENT_EFFORT": req.get("effort", "high"), "GOND_AGENT_HOME": "/tmp/gond-agent"})
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
            command(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Gond Agent", "-c", "user.email=agent@localhost", "commit", "-m", req.get("title", "Agent changes")])
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
    def relay(self):
        if (self.command, self.path) not in [("GET", "/v1/models"), ("POST", "/v1/responses")]:
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
            while True:
                frame = replies.get(timeout=600)
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
