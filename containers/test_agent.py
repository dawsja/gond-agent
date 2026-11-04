import base64
import concurrent.futures
import contextlib
import http.client
import http.server
import json
import socket
import threading
import time
import importlib.util
import io
import os
import pathlib
import queue
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("agent", pathlib.Path(__file__).with_name("agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        agent.ROOT = self.temp.name
        agent.events = []
        agent.worker = None
        agent.relay_token = "fixture-relay-secret"

    def tearDown(self):
        agent.worker = None
        agent.relay_token = None
        self.temp.cleanup()

    def test_search_relay_cancels_when_worker_disconnects(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), agent.ModelProxy)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        output = io.StringIO()
        connection = None
        try:
            with contextlib.redirect_stdout(output):
                connection = socket.create_connection(server.server_address)
                body = b'{"query":"fixture"}'
                connection.sendall(b"POST /v1/search HTTP/1.1\r\nHost: localhost:8787\r\nAuthorization: Bearer " + agent.relay_token.encode() + b"\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
                deadline = time.monotonic() + 3
                while not output.getvalue() and time.monotonic() < deadline:
                    time.sleep(0.01)
                frames = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(frames[0]["model"]["path"], "/v1/search")
                connection.close()
                connection = None
                while "model_cancel" not in output.getvalue() and time.monotonic() < deadline:
                    time.sleep(0.01)
                frames = [json.loads(line) for line in output.getvalue().splitlines()]
                self.assertEqual(frames[-1]["model_cancel"], frames[0]["model"]["id"])
                self.assertNotIn(frames[0]["model"]["id"], agent.models)
        finally:
            if connection:
                connection.close()
            server.shutdown()
            server.server_close()

    def test_start_environment_restores_plan_and_reminder_settings(self):
        plan = [{"text": "Continue work", "status": "in_progress"}]
        env = agent.worker_env({"model": "fixture", "plan": plan, "plan_reminder_every": 0, "plan_nudge_limit": 2})
        self.assertEqual(json.loads(env["GOND_AGENT_INITIAL_PLAN"]), plan)
        self.assertEqual(env["GOND_AGENT_PLAN_REMINDER_EVERY"], "0")
        self.assertEqual(env["GOND_AGENT_PLAN_NUDGE_LIMIT"], "2")

    def test_questions_require_explicit_interactive_start(self):
        self.assertEqual(agent.worker_env({"model": "fixture", "question_wait_minutes": 8})["GOND_AGENT_QUESTION_WAIT_MINUTES"], "8")
        for value in [None, False, "true", 1]:
            self.assertEqual(agent.worker_env({"model": "fixture", "interactive": value})["GOND_AGENT_INTERACTIVE"], "false")
        self.assertEqual(agent.worker_env({"model": "fixture", "interactive": True})["GOND_AGENT_INTERACTIVE"], "true")

    def test_toolchain_environment_reaches_worker_and_shell(self):
        homes = {"BUN_INSTALL": "bun", "CARGO_HOME": "cargo", "RUSTUP_HOME": "rustup",
                 "UV_INSTALL_DIR": "bin", "UV_TOOL_DIR": "uv/tools",
                 "UV_PYTHON_INSTALL_DIR": "uv/python", "UV_TOOL_BIN_DIR": "bin",
                 "XDG_BIN_HOME": "bin", "XDG_DATA_HOME": "share", "PYTHONUSERBASE": "python",
                 "npm_config_prefix": "npm", "COREPACK_HOME": "corepack", "PNPM_HOME": "pnpm",
                 "TMPDIR": "tmp", "TMP": "tmp", "TEMP": "tmp", "TEMPDIR": "tmp",
                 "BUN_INSTALL_CACHE_DIR": "cache/bun", "npm_config_cache": "cache/npm",
                 "XDG_CACHE_HOME": "cache", "PIP_CACHE_DIR": "cache/pip", "UV_CACHE_DIR": "cache/uv"}
        expected = {key: f"/opt/gond-tools/{value}" for key, value in homes.items()}
        tool_path = ":".join(f"/opt/gond-tools/{directory}" for directory in
                             ("bin", "bun/bin", "cargo/bin", "npm/bin", "pnpm", "python/bin"))
        expected["PATH"] = os.environ["PATH"] + ":" + tool_path
        dockerfile = (pathlib.Path(__file__).resolve().parents[1] / "Dockerfile").read_text()
        for key, value in expected.items():
            if key != "PATH":
                self.assertIn(f"{key}={value}", dockerfile)
        self.assertIn('ENV PATH="${PATH}:' + tool_path + '"', dockerfile)
        self.assertIn("PLAYWRIGHT_BROWSERS_PATH=/opt/gond-agent-browser/browsers", dockerfile)
        self.assertIn("NODE_PATH=/opt/gond-agent-browser/node_modules", dockerfile)
        self.assertIn("mkdir -p /workspace/repo /home/gond-agent /opt/gond-tools/bin /opt/gond-tools/tmp /opt/gond-tools/cache", dockerfile)
        self.assertIn("chown -R 1000:1000 /workspace /home/gond-agent /opt/gond-tools", dockerfile)
        self.assertIn("bun-v1.4.4/bun-linux-x64.zip", dockerfile)
        self.assertIn('echo "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c  /tmp/bun.zip" | sha256sum -c -', dockerfile)
        self.assertIn("/tmp/bun/bun-linux-x64/bun /usr/local/bin/bun", dockerfile)
        self.assertNotIn("CARGO_TARGET_DIR=", dockerfile)
        script = """
import agent, json, subprocess
from agent import worker_env
agent.relay_token = "fixture-relay-secret"
output = subprocess.check_output(
    ["/bin/bash", "-c", "python3 -c 'import json,os; print(json.dumps(dict(os.environ)))'"],
    env=worker_env({"model": "fixture"}), text=True)
print(output)
"""
        output = subprocess.check_output(
            ["python3", "-c", script], cwd=pathlib.Path(__file__).parent,
            env={**os.environ, **expected}, text=True)
        shell_env = json.loads(output)
        for key, value in expected.items():
            self.assertEqual(shell_env[key], value)

    def test_archive_rejects_escape_and_unsafe_links(self):
        for symlink in [False, True]:
            body = io.BytesIO()
            with tarfile.open(fileobj=body, mode="w:gz") as tar:
                entry = tarfile.TarInfo("link" if symlink else "../escape")
                if symlink:
                    entry.type = tarfile.SYMTYPE
                    entry.linkname = "../escape"
                    tar.addfile(entry)
                else:
                    entry.size = 1
                    tar.addfile(entry, io.BytesIO(b"x"))
            with self.assertRaises(tarfile.FilterError):
                agent.dispatch({"method": "setup", "archive": base64.b64encode(body.getvalue()).decode()})

    def test_snapshot_exports_git_objects_and_never_runs_hooks(self):
        def git(*args):
            return subprocess.check_output(["git", *args], cwd=agent.ROOT, stderr=subprocess.DEVNULL)
        git("init", "-q")
        pathlib.Path(agent.ROOT, "a.txt").write_text("hello")
        hook = pathlib.Path(agent.ROOT, ".git/hooks/pre-commit")
        hook.write_text("#!/bin/sh\ntouch hook-ran\nexit 17\n")
        hook.chmod(0o755)
        data = agent.dispatch({"method": "snapshot", "title": "Add hello", "identity": {"name": "connected-user", "email": "123+connected-user@users.noreply.github.com"}})
        bundle = pathlib.Path(agent.ROOT, "saved.bundle")
        bundle.write_bytes(base64.b64decode(data["bundle"]))
        self.assertEqual(git("log", "-1", "--format=%an <%ae>|%cn <%ce>").decode().strip(), "connected-user <123+connected-user@users.noreply.github.com>|connected-user <123+connected-user@users.noreply.github.com>")
        self.assertEqual(git("log", "-1", "--format=%B").decode().strip(), "Add hello")
        self.assertEqual(len(data["head"]), 40)
        git("bundle", "verify", str(bundle))
        self.assertEqual(git("show", "HEAD:a.txt"), b"hello")
        self.assertFalse(pathlib.Path(agent.ROOT, "hook-ran").exists())

    def test_snapshot_requires_connected_identity(self):
        subprocess.run(["git", "init", "-q"], cwd=agent.ROOT, check=True)
        pathlib.Path(agent.ROOT, "a.txt").write_text("hello")
        with self.assertRaisesRegex(RuntimeError, "connected GitHub"):
            agent.dispatch({"method": "snapshot"})

    def test_event_cursor_is_bounded_and_validated(self):
        agent.events = [{"n": i} for i in range(250)]
        batch = agent.dispatch({"method": "events", "after": 10})
        self.assertEqual(len(batch["events"]), 200)
        self.assertEqual(batch["events"][0]["n"], 10)
        with self.assertRaises(RuntimeError):
            agent.dispatch({"method": "events", "after": -1})

    def test_only_the_builtin_runner_starts_without_model_credentials(self):
        for method in ["cli_prepare", "cli_state", "cli_stop"]:
            with self.assertRaisesRegex(RuntimeError, "Unknown workspace method"):
                agent.dispatch({"method": method, "state": {"credentials": {"x": "eA=="}}, "config": {}})
        env = agent.worker_env({"model": "chatgpt.acct:gpt-5.5", "effort": "low", "backend": "codex"})
        self.assertEqual(env["GOND_AGENT_API_URL"], "http://127.0.0.1:8787")
        self.assertEqual(env["GOND_AGENT_MODEL"], "chatgpt.acct:gpt-5.5")
        self.assertEqual(env["GOND_AGENT_RELAY_TOKEN"], agent.relay_token)
        added = set(env) - set(os.environ)
        self.assertEqual(added, {"GOND_AGENT_RELAY_TOKEN", "GOND_AGENT_API_URL", "GOND_AGENT_MODEL", "GOND_AGENT_EFFORT", "GOND_AGENT_HOME", "GOND_AGENT_INITIAL_PLAN", "GOND_AGENT_PLAN_REMINDER_EVERY", "GOND_AGENT_PLAN_NUDGE_LIMIT", "GOND_AGENT_INTERACTIVE", "GOND_AGENT_QUESTION_WAIT_MINUTES",
                                "GOND_AGENT_EVIDENCE_BASE_SHA", "GOND_AGENT_EVIDENCE", "GOND_AGENT_EVIDENCE_REPO_POLICY",
                                "GOND_AGENT_EVIDENCE_SEQ", "GOND_AGENT_EVIDENCE_GATE_ROUNDS", "GOND_AGENT_EVIDENCE_RESUMES"} - set(os.environ))
        self.assertEqual(env["GOND_AGENT_EVIDENCE"], "on")
        self.assertEqual(env["GOND_AGENT_EVIDENCE_GATE_ROUNDS"], "0")
        configured = agent.worker_env({"model": "fixture", "evidence_base_sha": "a" * 40,
                                       "evidence_mode": "off", "evidence_repo_policy": "allow-weaken",
                                       "evidence_seq": 7, "evidence_gate_rounds": 4, "evidence_resumes": 2})
        self.assertEqual(configured["GOND_AGENT_EVIDENCE_BASE_SHA"], "a" * 40)
        self.assertEqual(configured["GOND_AGENT_EVIDENCE"], "off")
        self.assertEqual(configured["GOND_AGENT_EVIDENCE_REPO_POLICY"], "allow-weaken")
        self.assertEqual(configured["GOND_AGENT_EVIDENCE_SEQ"], "7")
        self.assertEqual(configured["GOND_AGENT_EVIDENCE_GATE_ROUNDS"], "4")
        self.assertEqual(configured["GOND_AGENT_EVIDENCE_RESUMES"], "2")

    def test_each_dispatch_start_passes_a_fresh_token_only_in_worker_environment(self):
        output, errors, log = io.StringIO(), io.StringIO(), io.BytesIO()
        spawns = []

        def spawn(args, **kwargs):
            self.assertTrue(agent.worker_lock.locked())
            self.assertEqual(kwargs["env"]["GOND_AGENT_RELAY_TOKEN"], agent.relay_token)
            spawns.append((args, kwargs))
            process = mock.Mock(stdout=io.StringIO(""))
            process.poll.return_value = 0
            return process

        def generate(size):
            self.assertTrue(agent.worker_lock.locked())
            return original_generate(size)

        original_generate = agent.secrets.token_urlsafe
        inherited_token = os.environ.get("GOND_AGENT_RELAY_TOKEN")
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors), \
                mock.patch.dict(os.environ, {"TMPDIR": self.temp.name}), \
                mock.patch.object(agent, "open", side_effect=lambda *_: contextlib.nullcontext(log), create=True), \
                mock.patch.object(agent.subprocess, "Popen", side_effect=spawn), \
                mock.patch.object(agent.secrets, "token_urlsafe", side_effect=generate) as generate_token:
            for request_id in (1, 2):
                agent.handle({"id": request_id, "method": "start", "model": "fixture"})

        self.assertEqual(os.environ.get("GOND_AGENT_RELAY_TOKEN"), inherited_token)
        self.assertEqual(generate_token.call_args_list, [mock.call(32), mock.call(32)])
        self.assertEqual(len(spawns), 2)
        tokens = [kwargs["env"]["GOND_AGENT_RELAY_TOKEN"] for _, kwargs in spawns]
        self.assertNotEqual(*tokens)
        for args, _ in spawns:
            self.assertEqual(args, ["/usr/local/bin/gond-agent-worker"])
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()],
                         [{"id": 1, "result": True}, {"id": 2, "result": True}])
        for token in tokens:
            self.assertNotIn(token, repr([args for args, _ in spawns]))
            self.assertNotIn(token, output.getvalue() + errors.getvalue() + log.getvalue().decode())

    def test_rejected_start_preserves_live_worker_and_failed_spawn_revokes_token(self):
        live_worker = mock.Mock()
        live_worker.poll.return_value = None
        agent.worker = live_worker
        with mock.patch.object(agent.secrets, "token_urlsafe") as generate:
            with self.assertRaisesRegex(RuntimeError, "already running"):
                agent.dispatch({"method": "start", "model": "fixture"})
            generate.assert_not_called()
        self.assertEqual(agent.relay_token, "fixture-relay-secret")
        self.assertIs(agent.worker, live_worker)

        agent.worker = None
        with mock.patch.dict(os.environ, {"TMPDIR": self.temp.name}), \
                mock.patch.object(agent, "open", return_value=contextlib.nullcontext(io.BytesIO()), create=True), \
                mock.patch.object(agent.subprocess, "Popen", side_effect=OSError("Cannot start worker")):
            with self.assertRaises(OSError):
                agent.dispatch({"method": "start", "model": "fixture"})
        self.assertIsNone(agent.relay_token)
        with self.assertRaisesRegex(RuntimeError, "not ready"):
            agent.worker_env({"model": "fixture"})


class ModelProxyTest(unittest.TestCase):
    endpoints = (("GET", "/v1/models"), ("POST", "/v1/responses"), ("POST", "/v1/search"))

    def setUp(self):
        self.token = agent.secrets.token_urlsafe(32)
        agent.relay_token = self.token
        self.output, self.errors = io.StringIO(), io.StringIO()
        self.responses = []
        self.frames = queue.Queue()
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(contextlib.redirect_stderr(self.errors))
        original_emit = agent.emit

        def emit(frame):
            original_emit(frame)
            self.frames.put(frame)

        self.stack.enter_context(mock.patch.object(agent, "emit", side_effect=emit))
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), agent.ModelProxy)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.stack.close()
        agent.relay_token = None
        self.assertNotIn(self.token, self.output.getvalue() + self.errors.getvalue() + "".join(self.responses))
        self.assertFalse(agent.models)

    def request(self, method="POST", path="/v1/responses", *, authorization="valid",
                hosts=("127.0.0.1:8787",), content_type="application/json", headers=(), body=b"{}"):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for host in hosts:
                connection.putheader("Host", host)
            if authorization is not None:
                connection.putheader("Authorization", "Bearer " + self.token if authorization == "valid" else authorization)
            if content_type is not None:
                connection.putheader("Content-Type", content_type)
            for key, value in headers:
                connection.putheader(key, value)
            connection.putheader("Content-Length", str(len(body)))
            connection.endheaders(body)
            response = connection.getresponse()
            data = response.read()
            self.responses.append(repr(response.getheaders()) + data.decode(errors="replace"))
            return response.status, data
        finally:
            connection.close()

    def assert_rejected(self, status, **kwargs):
        actual, body = self.request(**kwargs)
        self.assertEqual(actual, status)
        self.assertNotIn(self.token.encode(), body)
        self.assertTrue(self.frames.empty(), "Rejected requests must not emit upstream frames")
        return body

    def test_authentication_precedes_all_paths_and_methods(self):
        expected = None
        for method, path in [*self.endpoints, ("GET", "/v1/images/secret"),
                             ("POST", "/v1/images/generations"), ("OPTIONS", "/v1/responses"),
                             ("DELETE", "/unsupported")]:
            for auth in (None, "Bearer wrong", "Basic wrong", "Bearer non-ascii-\u00e9"):
                with self.subTest(method=method, path=path, auth=auth):
                    body = self.assert_rejected(401, method=method, path=path, authorization=auth,
                                                headers=(("Origin", "https://untrusted.example"),), content_type="text/plain")
                    expected = body if expected is None else expected
                    self.assertEqual(body, expected)
        self.assert_rejected(401, headers=(("Authorization", "Bearer " + self.token),))
        agent.relay_token = None
        self.assert_rejected(401)

    def test_browser_origins_and_untrusted_or_duplicate_hosts_are_forbidden(self):
        for method, path in self.endpoints:
            for origin in ("https://untrusted.example", "null", ""):
                with self.subTest(method=method, path=path, origin=origin):
                    self.assert_rejected(403, method=method, path=path, headers=(("Origin", origin),))
            for hosts in ((), ("evil.example:8787",), ("127.0.0.1",), ("localhost",),
                          ("127.0.0.1:8787.evil.example",), ("LOCALHOST:8787",),
                          ("localhost:8787", "localhost:8787"), ("127.0.0.1:8787, localhost:8787",)):
                with self.subTest(method=method, path=path, hosts=hosts):
                    self.assert_rejected(403, method=method, path=path, hosts=hosts)

    def test_browser_simple_posts_never_reach_upstream(self):
        for path in ("/v1/responses", "/v1/search"):
            for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=fixture"):
                with self.subTest(path=path, content_type=content_type):
                    # A browser can send these without a CORS preflight, but cannot
                    # attach Authorization. Neither this nor a leaked token grants Origin access.
                    headers = (("Origin", "https://untrusted.example"),)
                    self.assert_rejected(401, path=path, authorization=None,
                                         headers=headers, content_type=content_type)
                    self.assert_rejected(403, path=path, headers=headers, content_type=content_type)

    def test_post_requires_json_and_unsupported_endpoints_stay_forbidden(self):
        for path in ("/v1/responses", "/v1/search"):
            for content_type in (None, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data"):
                with self.subTest(path=path, content_type=content_type):
                    self.assert_rejected(415, path=path, content_type=content_type)
            self.assert_rejected(415, path=path, headers=(("Content-Type", "application/json"),))
        for method, path in [("POST", "/v1/images/generations"), ("GET", "/v1/images/secret"),
                             ("OPTIONS", "/v1/models"), ("PUT", "/v1/responses")]:
            self.assert_rejected(403, method=method, path=path)

    def test_body_and_concurrency_limits_remain_enforced(self):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=3)
        try:
            connection.request("POST", "/v1/responses", headers={
                "Host": "localhost:8787", "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json", "Content-Length": str(96 * 1024 * 1024 + 1)})
            response = connection.getresponse()
            self.responses.append(response.read().decode())
            self.assertEqual(response.status, 413)
        finally:
            connection.close()
        with agent.model_lock:
            agent.models.update({str(i): queue.Queue() for i in range(16)})
        try:
            self.assert_rejected(429)
        finally:
            with agent.model_lock:
                agent.models.clear()
        self.assertTrue(self.frames.empty())

    def test_authenticated_catalog_inference_and_search_keep_the_wire_format(self):
        for method, path, host in [("GET", "/v1/models", "localhost:8787"),
                                   ("POST", "/v1/responses", "127.0.0.1:8787"),
                                   ("POST", "/v1/search", "localhost:8787")]:
            with self.subTest(path=path), concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                body = b"" if method == "GET" else b'{"fixture":true}'
                result = executor.submit(self.request, method, path, hosts=(host,), body=body,
                                         content_type=None if method == "GET" else "application/json; charset=utf-8")
                frame = self.frames.get(timeout=3)
                model = frame["model"]
                self.assertEqual(frame, {"model": {"id": model["id"], "method": method,
                                                  "path": path, "body": base64.b64encode(body).decode()}})
                with agent.model_lock:
                    replies = agent.models[model["id"]]
                replies.put({"status": 200, "headers": {"content-type": "application/json"}})
                replies.put({"chunk": base64.b64encode(b'{"ok":true}').decode(), "end": True})
                self.assertEqual(result.result(timeout=3), (200, b'{"ok":true}'))
                self.assertEqual(self.frames.get(timeout=3), {"model_cancel": model["id"]})


class FakeStateWorker:
    """Queue-backed JSONL worker; acknowledgements make drains deterministic."""
    def __init__(self):
        self.requests = queue.Queue()
        self.frames = queue.Queue()
        self.stdin = self
        self.stdout = self.lines()
        self.returncode = None

    def poll(self):
        return self.returncode

    def write(self, line):
        self.requests.put(json.loads(line))

    def flush(self):
        pass

    def wait(self, timeout=None):
        return 0

    pid = 123456789  # Never a real worker process group.

    def lines(self):
        while True:
            item = self.frames.get()
            if item is None:
                return
            frame, drained = item
            yield json.dumps(frame) + "\n"
            drained.set()

    def reply(self, frame):
        drained = threading.Event()
        self.frames.put((frame, drained))
        if not drained.wait(3):
            raise AssertionError("Controller did not drain the fake worker")


class StateControlTest(unittest.TestCase):
    def setUp(self):
        self.workers = []
        self.threads = []
        self.old = self.new_worker()
        self.real_write = agent.write_state_frame
        patcher = mock.patch.object(agent, "write_state_frame", side_effect=self.fake_write)
        patcher.start()
        self.addCleanup(patcher.stop)
        for name, value in (("worker", self.old), ("events", []), ("state_waiters", {}), ("held_boundary", None)):
            patcher = mock.patch.object(agent, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    @staticmethod
    def fake_write(source, frame, deadline):
        source.stdin.write(json.dumps(frame))
        source.stdin.flush()

    def tearDown(self):
        for worker in self.workers:
            worker.frames.put(None)
        for thread in self.threads:
            thread.join(3)
            self.assertFalse(thread.is_alive(), "Controller thread did not finish")
        self.assertFalse(agent.state_waiters)

    def new_worker(self, start=True):
        worker = FakeStateWorker()
        self.workers.append(worker)
        if start:
            thread = threading.Thread(target=agent.drain, args=(worker.stdout, worker), daemon=True)
            self.threads.append(thread)
            thread.start()
        return worker

    def begin(self, operation="export_state", **extra):
        results = queue.Queue()

        def run():
            try:
                results.put(agent.dispatch({"method": operation, "run_id": "run", "owner_id": "owner", **extra}))
            except Exception as error:
                results.put(error)

        thread = threading.Thread(target=run, daemon=True)
        self.threads.append(thread)
        thread.start()
        frame = agent.worker.requests.get(timeout=3)
        return frame, results

    def test_checkpoint_capture_pairs_state_and_tree_until_explicit_release(self):
        notices = []
        tree = {"bundle": "opaque", "base_sha": "base", "head_sha": "head", "checkpoint_sha": "commit"}
        with mock.patch.object(agent, "emit", side_effect=notices.append), \
                mock.patch.object(agent, "checkpoint_tree", return_value=tree) as capture_tree:
            self.old.reply({"type": "checkpoint.ready", "boundary_id": "1"})
            token = notices[0]["checkpoint"]["boundary_id"]
            self.assertNotEqual(token, "1")
            frame, results = self.begin("checkpoint", boundary_id=token)
            self.assertEqual(frame["type"], "export_state")
            self.assertEqual(frame["boundary_id"], "1")
            self.assertFalse(capture_tree.called, "tree must wait for the held state reply")
            for operation in ("checkpoint", "checkpoint.release", "snapshot"):
                with self.assertRaisesRegex(RuntimeError, "already pending"):
                    agent.dispatch({"method": operation, "boundary_id": token})
            state = {"private": "paired history"}
            self.old.reply({"type": "state.exported", "request_id": frame["request_id"], "state": state})
            self.assertEqual(results.get(timeout=3), {**tree, "state": state, "boundary_id": token})
            self.assertEqual(agent.held_boundary[1], token, "API persistence must precede release")
            with self.assertRaisesRegex(RuntimeError, "held for a checkpoint"):
                agent.dispatch({"method": "snapshot"})
            self.assertTrue(self.old.requests.empty(), "capture must not implicitly resume the runner")
            frame, results = self.begin("checkpoint.release", boundary_id=token)
            self.assertEqual(frame["type"], "checkpoint.release")
            self.assertEqual(frame["boundary_id"], "1")
            self.old.reply({"type": "checkpoint.released", "request_id": frame["request_id"]})
            self.assertIs(results.get(timeout=3), True)
            self.assertIsNone(agent.held_boundary)
            with self.assertRaisesRegex(RuntimeError, "no longer available"):
                agent.dispatch({"method": "checkpoint", "boundary_id": token})
            # A stale worker cannot publish a boundary; controls never enter events.
            stale = self.new_worker()
            stale.reply({"type": "checkpoint.ready", "boundary_id": "1"})
            self.old.reply({"type": "checkpoint.future", "state": state})
            self.assertEqual(len(notices), 1)
            self.assertEqual(agent.events, [])
            with mock.patch.object(agent, "worker", stale):
                with self.assertRaisesRegex(RuntimeError, "not running"):
                    agent.state_rpc({"method": "checkpoint.release", "boundary_id": "1"}, expected_worker=self.old)
                self.assertTrue(stale.requests.empty(), "a stale capture must never release a replacement worker")

    def test_explicit_idle_hold_uses_ready_before_export_ack_and_keeps_it_held(self):
        notices = []
        with mock.patch.object(agent, "emit", side_effect=notices.append):
            frame, results = self.begin(quiescent=True, hold=True)
            self.assertIs(frame["hold"], True)
            self.assertIs(frame["quiescent"], True)
            self.old.reply({"type": "checkpoint.ready", "boundary_id": "4"})
            token = notices[0]["checkpoint"]["boundary_id"]
            self.assertTrue(results.empty(), "hold must be established before export acknowledges")
            self.old.reply({"type": "state.exported", "request_id": frame["request_id"], "state": {}})
            self.assertEqual(results.get(timeout=3), {"state": {}})
            self.assertEqual(agent.held_boundary[1], token)
            self.assertEqual(agent.events, [])
            frame, results = self.begin("checkpoint.release", boundary_id=token)
            self.old.reply({"type": "checkpoint.released", "request_id": frame["request_id"]})
            self.assertIs(results.get(timeout=3), True)

    def test_canonical_snapshot_runs_only_inside_unheld_capture_lock_and_releases_on_failure(self):
        request = {"method": "snapshot", "title": "Canonical publication"}

        def snapshot(req):
            self.assertIs(req, request)
            self.assertTrue(agent.capture_lock.locked())
            self.assertIsNone(agent.held_boundary)
            raise RuntimeError("snapshot fixture failed")

        with mock.patch.object(agent, "snapshot_tree", side_effect=snapshot) as publish:
            with agent.capture_lock:
                with self.assertRaisesRegex(RuntimeError, "already pending"):
                    agent.dispatch(request)
            with mock.patch.object(agent, "held_boundary", (self.old, "opaque", "1")):
                with self.assertRaisesRegex(RuntimeError, "held for a checkpoint"):
                    agent.dispatch(request)
            publish.assert_not_called()
            self.assertFalse(agent.capture_lock.locked())
            with self.assertRaisesRegex(RuntimeError, "snapshot fixture failed"):
                agent.dispatch(request)
            publish.assert_called_once_with(request)
            self.assertFalse(agent.capture_lock.locked())

    def test_failed_checkpoint_capture_stays_held_for_caller_finally_release(self):
        notices = []
        with mock.patch.object(agent, "emit", side_effect=notices.append), \
                mock.patch.object(agent, "checkpoint_tree", side_effect=RuntimeError("fixture")):
            self.old.reply({"type": "checkpoint.ready", "boundary_id": "2"})
            token = notices[0]["checkpoint"]["boundary_id"]
            frame, results = self.begin("checkpoint", boundary_id=token)
            self.old.reply({"type": "state.exported", "request_id": frame["request_id"], "state": {}})
            self.assertIsInstance(results.get(timeout=3), RuntimeError)
            self.assertEqual(agent.held_boundary[1], token)
            frame, results = self.begin("checkpoint.release", boundary_id=token)
            # Next ready can beat the old release RPC's return; it must not be lost.
            self.old.reply({"type": "checkpoint.released", "request_id": frame["request_id"]})
            self.old.reply({"type": "checkpoint.ready", "boundary_id": "3"})
            self.assertIs(results.get(timeout=3), True)
            self.assertEqual(agent.held_boundary[2], "3")
            self.assertEqual(len(notices), 2)

    def test_dedicated_round_trip_is_correlated_bounded_and_not_an_event(self):
        frame, results = self.begin(request_id="caller-controlled")
        self.assertEqual(frame["type"], "export_state")
        self.assertEqual((frame["run_id"], frame["owner_id"]), ("run", "owner"))
        self.assertNotEqual(frame["request_id"], "caller-controlled")
        self.assertEqual(len(agent.state_waiters), 1)
        with self.assertRaisesRegex(RuntimeError, "already pending"):
            agent.dispatch({"method": "export_state"})
        # Waiting must leave worker_lock available to ordinary input/interrupts.
        self.assertTrue(agent.dispatch({"method": "send", "input": {"type": "interrupt"}}))
        self.assertEqual(self.old.requests.get_nowait(), {"type": "interrupt"})
        self.old.reply({"type": "text.delta", "text": "ordinary"})
        state = {"private": "repository/provider content", "unicode": "é"}
        self.old.reply({"type": "state.exported", "request_id": frame["request_id"], "state": state})
        self.assertEqual(results.get(timeout=3), {"state": state})
        self.assertEqual(agent.dispatch({"method": "events"})["events"], [{"type": "text.delta", "text": "ordinary"}])
        frame, results = self.begin("import_state", state=state)
        self.assertEqual(frame["state"], state)
        self.old.reply({"type": "state.imported", "request_id": frame["request_id"]})
        self.assertIs(results.get(timeout=3), True)
        self.assertEqual(len(agent.events), 1)

    def test_pipe_backpressure_is_bounded_and_discards_partial_frame(self):
        # A real live worker that never reads stdin fills the pipe during import.
        source = subprocess.Popen(["python3", "-c", "import time; time.sleep(60)"],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)
        self.addCleanup(source.stdout.close)
        self.addCleanup(source.stdin.close)
        self.addCleanup(lambda: source.poll() is None and source.kill())
        with mock.patch.object(agent, "worker", source), \
                mock.patch.object(agent, "write_state_frame", self.real_write), \
                mock.patch.object(agent, "STATE_TIMEOUT", 0.05):
            results = queue.Queue()

            def run():
                try:
                    agent.dispatch({"method": "import_state", "run_id": "run", "owner_id": "owner",
                                    "state": {"private": "x" * (1024 * 1024)}})
                except Exception as error:
                    results.put(error)

            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            try:
                self.assertIsInstance(results.get(timeout=3), RuntimeError)
                self.assertIsNone(agent.worker)
                self.assertIsNotNone(source.poll())
                self.assertFalse(agent.state_waiters)
                self.assertTrue(agent.worker_lock.acquire(timeout=1))
                agent.worker_lock.release()
            finally:
                source.kill()
                source.wait(timeout=3)
                thread.join(3)

    def test_evidence_key_uses_only_the_private_correlated_control_path(self):
        key = "07" * 32
        environment = dict(os.environ)
        frame, results = self.begin("init_evidence", key=key, request_id="caller-controlled")
        self.assertEqual(set(frame), {"type", "request_id", "run_id", "owner_id", "key"})
        self.assertEqual(frame["type"], "init_evidence")
        self.assertTrue(frame["key"] == key)
        self.assertNotEqual(frame["request_id"], "caller-controlled")
        # Wrong-operation and unsolicited key-shaped replies never become events.
        self.old.reply({"type": "state.imported", "request_id": frame["request_id"], "key": key})
        self.assertTrue(results.empty())
        self.old.reply({"type": "state.evidence_initialized", "request_id": frame["request_id"]})
        self.assertIs(results.get(timeout=3), True)
        self.assertEqual(agent.dispatch({"method": "events"})["events"], [])
        self.assertEqual(os.environ, environment)
        for invalid in (None, "x" * 64, key + "00", "PRIVATE-EVIDENCE-KEY"):
            with self.assertRaisesRegex(RuntimeError, "Invalid evidence initialization"):
                agent.dispatch({"method": "init_evidence", "run_id": "run", "owner_id": "owner", "key": invalid})
        self.assertTrue(self.old.requests.empty())

    def test_unsolicited_stale_wrong_operation_and_late_frames_are_dropped(self):
        secret = {"private": "must never enter events"}
        for kind in ("state.exported", "state.imported", "state.evidence_initialized", "state.error", "state.future"):
            event = {"type": kind, "request_id": "unsolicited", "state": secret}
            self.old.reply(event)
            agent.drain(io.StringIO(json.dumps(event) + "\n"))
        # A zero timeout deterministically releases the waiter without sleeping.
        with mock.patch.object(agent, "STATE_TIMEOUT", 0):
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                agent.dispatch({"method": "export_state"})
        late = self.old.requests.get_nowait()
        self.assertFalse(agent.state_waiters)
        frame, results = self.begin()
        stale = self.new_worker()
        stale.reply({"type": "state.exported", "request_id": frame["request_id"], "state": secret})
        stale.frames.put(None)
        self.threads[-1].join(3)
        self.assertFalse(self.threads[-1].is_alive())
        self.old.reply({"type": "state.exported", "request_id": late["request_id"], "state": secret})
        self.old.reply({"type": "state.imported", "request_id": frame["request_id"]})
        self.old.reply({"type": "state.error", "request_id": frame["request_id"], "operation": "import_state", "code": "bad"})
        self.assertTrue(results.empty())
        self.old.reply({"type": "state.exported", "request_id": frame["request_id"], "state": {"ok": True}})
        self.assertEqual(results.get(timeout=3), {"state": {"ok": True}})
        self.old.reply({"type": "state.error", "request_id": frame["request_id"], "operation": "export_state", "code": "late"})
        self.assertEqual(agent.events, [])

    def test_replacement_and_eof_fail_waiters_without_accepting_old_replies(self):
        frame, results = self.begin()
        replacement = self.new_worker(start=False)
        self.old.returncode = 0
        real_thread = threading.Thread

        def tracked_thread(*args, **kwargs):
            thread = real_thread(*args, **kwargs)
            self.threads.append(thread)
            return thread

        with mock.patch.object(agent.subprocess, "Popen", return_value=replacement), \
                mock.patch.object(agent.threading, "Thread", side_effect=tracked_thread), \
                mock.patch.dict(os.environ, {"TMPDIR": tempfile.gettempdir()}), \
                mock.patch("builtins.open", mock.mock_open()):
            self.assertTrue(agent.dispatch({"method": "start", "model": "fixture"}))
        self.assertIsInstance(results.get(timeout=3), RuntimeError)
        current, results = self.begin()
        self.old.reply({"type": "state.exported", "request_id": current["request_id"], "state": {"secret": "old"}})
        self.old.reply({"type": "state.exported", "request_id": frame["request_id"], "state": {"secret": "late"}})
        self.assertTrue(results.empty())
        replacement.frames.put(None)
        self.assertIsInstance(results.get(timeout=3), RuntimeError)
        self.assertFalse(agent.state_waiters)
        self.assertEqual(agent.events, [])

    def test_send_cannot_bypass_state_controls(self):
        for kind in ("export_state", "import_state", "init_evidence", "state.exported", "state.imported",
                     "state.evidence_initialized", "state.error", "checkpoint.release", "checkpoint.ready", "checkpoint.future"):
            with self.subTest(kind=kind), self.assertRaisesRegex(RuntimeError, "dedicated"):
                agent.dispatch({"method": "send", "input": {"type": kind, "state": {"secret": True}}})
        self.assertTrue(self.old.requests.empty())

    def test_errors_and_invalid_payloads_do_not_log_or_echo_private_content(self):
        output, errors = io.StringIO(), io.StringIO()
        frame, results = self.begin()
        self.old.reply({"type": "state.error", "request_id": frame["request_id"],
                        "operation": "export_state", "code": "private-runner-error"})
        error = results.get(timeout=3)
        self.assertIsInstance(error, RuntimeError)
        self.assertNotIn("private", str(error))
        # Exercise the outer handler's traceback too, not just dispatch errors.
        for state in ({"private-field": float("nan")}, {"private-field": "\ud800"}, {"private-field": object()}):
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                agent.handle({"id": "safe-id", "method": "import_state", "state": state})
        self.assertTrue(self.old.requests.empty())
        with mock.patch.object(self.old, "flush", side_effect=BrokenPipeError("private-transport-error")), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            agent.handle({"id": "safe-id", "method": "export_state"})
        self.assertNotIn("private", output.getvalue() + errors.getvalue())
        self.assertFalse(agent.state_waiters)
        self.assertEqual(agent.events, [])

    def test_state_size_limit_measures_compact_utf8_on_import_and_export(self):
        self.assertEqual(agent.MAX_STATE, 4 * 1024 * 1024)
        # 8 bytes of JSON structure plus 2 UTF-8 bytes per é, not ASCII escapes.
        boundary = {"s": "é" * ((agent.MAX_STATE - 8) // 2)}
        self.assertEqual(len(agent.state_json(boundary).encode("utf-8")), agent.MAX_STATE)
        frame, results = self.begin("import_state", state=boundary)
        self.old.reply({"type": "state.imported", "request_id": frame["request_id"]})
        self.assertIs(results.get(timeout=3), True)
        oversized = {"s": boundary["s"] + "é"}
        with self.assertRaisesRegex(RuntimeError, "oversized"):
            agent.dispatch({"method": "import_state", "state": oversized})
        self.assertTrue(self.old.requests.empty())
        frame, results = self.begin()
        self.old.reply({"type": "state.exported", "request_id": frame["request_id"], "state": oversized})
        self.assertIsInstance(results.get(timeout=3), RuntimeError)
        self.assertFalse(agent.state_waiters)
        self.assertEqual(agent.events, [])


class CheckpointTest(unittest.TestCase):
    identity = {"name": "fixture", "email": "fixture@example.test"}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_root = agent.ROOT
        self.previous_worker = agent.worker
        self.root = pathlib.Path(self.temp.name, "clone")
        self.root.mkdir()
        agent.ROOT = str(self.root)
        agent.worker = None
        self.git("init", "-q", "-b", "run")
        self.git("config", "user.name", self.identity["name"])
        self.git("config", "user.email", self.identity["email"])
        self.write(".gitignore", "ignored*\n")
        self.write("edit.txt", "base\n")
        self.write("deleted.txt", "delete me\n")
        self.write("mode.sh", "#!/bin/sh\n")
        self.git("add", "--all")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").decode().strip()
        self.write("edit.txt", "head\n")
        self.git("commit", "-qam", "head")
        self.head = self.git("rev-parse", "HEAD").decode().strip()

    def tearDown(self):
        agent.ROOT = self.previous_root
        agent.worker = self.previous_worker
        self.temp.cleanup()

    def git(self, *args, cwd=None, input=None):
        env = {"PATH": "/usr/bin:/bin", "HOME": self.temp.name, "LC_ALL": "C",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
               "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z"}
        return subprocess.check_output(["/usr/bin/git", *args], cwd=cwd or self.root,
                                       env=env, input=input, stderr=subprocess.DEVNULL)

    def write(self, name, content):
        (self.root / name).write_text(content)

    def export(self, **kwargs):
        return agent.dispatch({"method": "checkpoint_tree", "base_sha": self.base,
                               "identity": self.identity, **kwargs})

    def restore(self, data, **kwargs):
        return agent.dispatch({**data, "method": "restore_checkpoint", **kwargs})

    def state(self):
        return (self.git("rev-parse", "HEAD"), self.git("symbolic-ref", "HEAD"),
                (self.root / ".git/index").read_bytes(), self.git("show-ref"))

    def assert_snapshot_publishes_worktree(self):
        self.write("edit.txt", "staged, not published\n")
        self.git("add", "edit.txt")
        self.write("edit.txt", "published worktree\n")
        self.write("new.txt", "published untracked\n")
        self.write("ignored-secret", "not published\n")
        (self.root / "deleted.txt").unlink()
        index = self.root / ".git/index"
        index_before = index.read_bytes()
        expected = agent.tree_hash()
        self.assertEqual(index.read_bytes(), index_before)
        published = agent.dispatch({"method": "snapshot", "identity": self.identity})
        head = published["head"]
        self.assertNotEqual(head, self.head)
        self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), head)
        self.assertEqual(self.git("rev-list", "--parents", "-n", "1", head).decode().strip(),
                         f"{head} {self.head}")
        self.assertEqual(self.git("rev-parse", "HEAD^{tree}").decode().strip(), expected)
        self.assertEqual(self.git("write-tree").decode().strip(), expected)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), b"")
        self.assertEqual(self.git("diff", "--name-only"), b"")
        self.assertNotEqual(index.read_bytes(), index_before)
        self.assertEqual(self.git("show", "HEAD:edit.txt"), b"published worktree\n")
        self.assertEqual(self.git("show", "HEAD:new.txt"), b"published untracked\n")
        self.assertNotIn(b"ignored-secret", self.git("ls-tree", "-r", "--name-only", "HEAD"))
        self.assertEqual((self.root / "ignored-secret").read_text(), "not published\n")
        self.assertFalse((self.root / ".git/index.lock").exists())

        # Inspect publication through an independent receiver, not the clone's
        # object store: the bundle must contain the advertised HEAD and tree.
        bundle = pathlib.Path(self.temp.name, "publication.bundle")
        bundle.write_bytes(base64.b64decode(published["bundle"]))
        receiver = pathlib.Path(self.temp.name, "receiver.git")
        self.git("init", "--bare", "-q", str(receiver))
        self.assertEqual(self.git("bundle", "list-heads", str(bundle), cwd=receiver).decode(),
                         f"{head} HEAD\n")
        self.git("bundle", "verify", str(bundle), cwd=receiver)
        self.git("fetch", "-q", str(bundle), "HEAD", cwd=receiver)
        self.assertEqual(self.git("rev-parse", "FETCH_HEAD", cwd=receiver).decode().strip(), head)
        self.assertEqual(self.git("rev-parse", "FETCH_HEAD^{tree}", cwd=receiver).decode().strip(), expected)
        self.assertEqual(self.git("ls-tree", "-r", "HEAD"),
                         self.git("ls-tree", "-r", "FETCH_HEAD", cwd=receiver))
        return head

    def test_snapshot_packed_branch_creates_loose_override_without_rewriting_packed_refs(self):
        self.git("pack-refs", "--all", "--prune")
        branch = self.root / ".git/refs/heads/run"
        self.assertFalse(branch.exists())
        packed = self.root / ".git/packed-refs"
        packed_before = packed.read_bytes()
        head_before = (self.root / ".git/HEAD").read_bytes()
        head = self.assert_snapshot_publishes_worktree()
        self.assertEqual((self.root / ".git/HEAD").read_bytes(), head_before)
        self.assertEqual(self.git("symbolic-ref", "HEAD"), b"refs/heads/run\n")
        self.assertEqual(branch.read_text(), head + "\n")
        self.assertEqual(packed.read_bytes(), packed_before)
        self.assertFalse(branch.with_name("run.lock").exists())

    def test_snapshot_detached_head_stays_detached_and_does_not_move_branch_refs(self):
        self.git("checkout", "-q", "--detach", self.head)
        refs_before = self.git("show-ref")
        head = self.assert_snapshot_publishes_worktree()
        self.assertEqual((self.root / ".git/HEAD").read_text(), head + "\n")
        with self.assertRaises(subprocess.CalledProcessError):
            self.git("symbolic-ref", "HEAD")
        self.assertEqual(self.git("show-ref"), refs_before)
        self.assertFalse((self.root / ".git/HEAD.lock").exists())

    def test_snapshot_busy_index_or_ref_preserves_head_index_worktree_and_existing_lock(self):
        self.write("edit.txt", "staged\n")
        self.git("add", "edit.txt")
        self.write("edit.txt", "unstaged\n")
        self.write("new.txt", "untracked\n")
        before = self.state()
        head_before = (self.root / ".git/HEAD").read_bytes()
        expected = agent.tree_hash()
        index_lock = self.root / ".git/index.lock"
        ref_lock = self.root / ".git/refs/heads/run.lock"
        for lock in (index_lock, ref_lock):
            with self.subTest(lock=lock.name):
                lock.write_bytes(b"owned by another Git operation\n")
                try:
                    with self.assertRaises(FileExistsError):
                        agent.dispatch({"method": "snapshot", "identity": self.identity})
                    self.assertEqual(lock.read_bytes(), b"owned by another Git operation\n")
                    self.assertEqual(self.state(), before)
                    self.assertEqual((self.root / ".git/HEAD").read_bytes(), head_before)
                    self.assertEqual(agent.tree_hash(), expected)
                    self.assertEqual((self.root / "edit.txt").read_text(), "unstaged\n")
                    self.assertEqual((self.root / "new.txt").read_text(), "untracked\n")
                    self.assertFalse(agent.capture_lock.locked())
                    self.assertFalse(agent.checkpoint_lock.locked())
                    other_lock = ref_lock if lock == index_lock else index_lock
                    self.assertFalse(other_lock.exists())
                finally:
                    lock.unlink()
        published = agent.dispatch({"method": "snapshot", "identity": self.identity})
        self.assertEqual(self.git("rev-parse", published["head"] + "^{tree}").decode().strip(), expected)
        self.assertEqual(self.git("write-tree").decode().strip(), expected)

    def test_upstream_pin_restores_local_commits_and_dirty_tree_without_local_history(self):
        upstream = pathlib.Path(self.temp.name, "upstream")
        self.git("clone", "-q", "--no-local", str(self.root), str(upstream))
        self.git("reset", "--hard", self.base, cwd=upstream)
        self.write("committed.txt", "local commit only\n")
        self.write("ignored-tracked", "tracked by local HEAD\n")
        self.git("add", "committed.txt")
        self.git("add", "--force", "ignored-tracked")
        self.git("commit", "-qm", "unpublished local work")
        local_head = self.git("rev-parse", "HEAD").decode().strip()
        self.write("edit.txt", "staged\n")
        self.git("add", "edit.txt")
        self.write("edit.txt", "dirty after local commit\n")
        self.write("dirty.txt", "untracked work\n")
        before = self.state()
        data = self.export(head_sha=self.base)
        self.assertEqual(self.state(), before)
        self.assertEqual(data["head_sha"], self.base)
        bundle = pathlib.Path(self.temp.name, "pinned.bundle")
        bundle.write_bytes(base64.b64decode(data["bundle"]))
        self.assertIn(b"\n-" + self.base.encode() + b" ", bundle.read_bytes().split(b"\n\n", 1)[0])

        fresh = pathlib.Path(self.temp.name, "fresh-pinned")
        self.git("clone", "-q", "--depth", "1", "--no-tags", upstream.as_uri(), str(fresh))
        self.root = fresh
        agent.ROOT = str(fresh)
        before = self.state()
        with self.assertRaises(subprocess.CalledProcessError):
            self.git("cat-file", "-e", local_head)
        self.restore(data)
        self.assertEqual(self.state(), before)
        self.assertEqual(self.git("rev-parse", "HEAD").decode().strip(), self.base)
        for name, content in (("committed.txt", "local commit only\n"),
                              ("ignored-tracked", "tracked by local HEAD\n"),
                              ("edit.txt", "dirty after local commit\n"),
                              ("dirty.txt", "untracked work\n")):
            self.assertEqual((fresh / name).read_text(), content)
        with self.assertRaises(subprocess.CalledProcessError):
            self.git("cat-file", "-e", local_head)

    def test_unchanged_tree_and_history_skip_bundle_but_either_change_captures(self):
        req = {"base_sha": self.base, "identity": self.identity}
        before = self.state()
        first = agent.checkpoint_tree(req, "history-a")
        req["previous_fingerprint"] = first["fingerprint"]
        original_bundle = pathlib.Path.read_bytes

        def no_bundle_read(path):
            if path.name == "checkpoint.bundle":
                self.fail("unchanged capture must not create/read a bundle")
            return original_bundle(path)

        with mock.patch.object(pathlib.Path, "read_bytes", no_bundle_read):
            self.assertEqual(agent.checkpoint_tree(req, "history-a"), {"unchanged": True})
        self.assertEqual(self.state(), before)
        history_changed = agent.checkpoint_tree(req, "history-b")
        self.assertIn("bundle", history_changed)
        self.assertNotEqual(history_changed["fingerprint"], first["fingerprint"])
        self.write("edit.txt", "changed tree\n")
        tree_changed = agent.checkpoint_tree(req, "history-a")
        self.assertIn("bundle", tree_changed)
        self.assertNotEqual(tree_changed["fingerprint"], first["fingerprint"])
        pinned = agent.checkpoint_tree({**req, "head_sha": self.base}, "history-a")
        self.assertNotEqual(pinned["fingerprint"], tree_changed["fingerprint"])

    def test_round_trip_preserves_head_index_branch_ignored_files_and_publication(self):
        self.write("edit.txt", "staged\n")
        self.git("add", "edit.txt")
        self.write("edit.txt", "working tree\n")
        self.write("new.txt", "untracked\n")
        (self.root / "deleted.txt").unlink()
        (self.root / "mode.sh").chmod(0o755)
        (self.root / "link").symlink_to("edit.txt")
        (self.root / "binary").write_bytes(b"\0\xff\x01")
        self.write("ignored-secret", "do not export\n")
        (self.root / ".git/info/exclude").write_text("local-exclude\n")
        self.write("local-exclude", "also do not export\n")
        before = self.state()
        data = self.export()
        self.assertEqual(self.state(), before)
        self.assertEqual(data["base_sha"], self.base)
        self.assertEqual(data["head_sha"], self.head)
        self.assertEqual(data, self.export())
        # Only the expected ref and a HEAD prerequisite are in the wire bundle.
        bundle = pathlib.Path(self.temp.name, "saved.bundle")
        bundle.write_bytes(base64.b64decode(data["bundle"]))
        self.assertEqual(self.git("bundle", "list-heads", str(bundle)).decode(),
                         f'{data["checkpoint_sha"]} {agent.CHECKPOINT_REF}\n')
        self.assertLess(len(bundle.read_bytes()), agent.MAX_CHECKPOINT_BUNDLE)
        fresh = pathlib.Path(self.temp.name, "fresh")
        self.git("clone", "-q", "--no-local", str(self.root), str(fresh))
        agent.ROOT = str(fresh)
        self.root = fresh
        self.write("ignored-secret", "keep local ignored data\n")
        staged_blob = self.git("rev-parse", self.base + ":edit.txt").decode().strip()
        self.git("update-index", "--cacheinfo", f"100644,{staged_blob},edit.txt")
        before = self.state()
        self.assertEqual(self.restore(data)["checkpoint_sha"], data["checkpoint_sha"])
        self.assertEqual(self.state(), before)
        self.assertEqual((fresh / "edit.txt").read_text(), "working tree\n")
        self.assertEqual((fresh / "new.txt").read_text(), "untracked\n")
        self.assertFalse((fresh / "deleted.txt").exists())
        self.assertEqual((fresh / "binary").read_bytes(), b"\0\xff\x01")
        self.assertEqual(os.readlink(fresh / "link"), "edit.txt")
        self.assertTrue((fresh / "mode.sh").stat().st_mode & 0o111)
        self.assertEqual((fresh / "ignored-secret").read_text(), "keep local ignored data\n")
        # The internal commit is never imported into the clone. Normal publication
        # subsequently commits on the original branch/HEAD without rewriting history.
        self.git("config", "user.name", self.identity["name"])
        self.git("config", "user.email", self.identity["email"])
        published = agent.dispatch({"method": "snapshot", "identity": self.identity})
        self.assertEqual(self.git("rev-parse", "HEAD^").decode().strip(), self.head)
        self.assertNotEqual(published["head"], data["checkpoint_sha"])
        self.assertNotIn(b"ignored-secret", self.git("ls-tree", "-r", "--name-only", "HEAD"))
        self.assertEqual((fresh / "local-exclude").read_text(), "also do not export\n")
        # Without a journal-authenticated published HEAD, recovery from the
        # pushed branch rejects the old HEAD pin but accepts the new one.
        final = self.export()
        self.assertEqual(final["head_sha"], published["head"])
        self.assertNotEqual(final["head_sha"], data["head_sha"])
        resumed = pathlib.Path(self.temp.name, "published-resume")
        self.git("clone", "-q", "--depth", "1", "--no-tags", fresh.as_uri(), str(resumed))
        agent.ROOT = str(resumed)
        self.root = resumed
        self.git("fetch", "-q", "origin", self.base)
        with self.assertRaisesRegex(RuntimeError, "HEAD does not match"):
            self.restore(data)
        self.assertEqual(self.restore(final)["head_sha"], published["head"])

    def test_tree_hash_ignores_private_excludes_and_detects_changes_without_mutation(self):
        self.write("edit.txt", "staged\n")
        self.git("add", "edit.txt")
        self.write("edit.txt", "working\n")
        self.write("untracked", "new\n")
        self.write("ignored-code", "outside evidence\n")
        (self.root / ".git/info/exclude").write_text("untracked\n")
        excludes = pathlib.Path(self.temp.name, "global-excludes")
        excludes.write_text("untracked\n")
        self.git("config", "core.excludesFile", str(excludes))
        before = self.state()
        first = agent.tree_hash()
        self.assertEqual(agent.tree_hash(), first)
        self.assertEqual(self.state(), before)
        self.write("untracked", "changed\n")
        self.assertNotEqual(agent.tree_hash(), first)
        self.write("untracked", "new\n")
        self.assertEqual(agent.tree_hash(), first)
        self.write("ignored-code", "still outside evidence\n")
        self.assertEqual(agent.tree_hash(), first)
        # .gitignore changes themselves invalidate evidence, but an already
        # ignored path remains outside the tree: callers must not trust its code.
        self.write(".gitignore", "ignored*\nuntracked\n")
        self.assertNotEqual(agent.tree_hash(), first)
        self.write(".gitignore", "ignored*\n")
        self.assertEqual(self.state(), before)
        data = self.export()
        bundle = pathlib.Path(self.temp.name, "tree.bundle")
        bundle.write_bytes(base64.b64decode(data["bundle"]))
        self.git("fetch", "-q", str(bundle), agent.CHECKPOINT_REF)
        self.assertEqual(self.git("rev-parse", data["checkpoint_sha"] + "^{tree}").decode().strip(), first)
        published = agent.dispatch({"method": "snapshot", "identity": self.identity, "title": "Publication"})
        self.assertEqual(self.git("rev-parse", published["head"] + "^{tree}").decode().strip(), first)
        self.assertEqual(self.git("diff", "--cached", "--name-only"), b"")
        self.assertEqual(self.git("show", "HEAD:untracked"), b"new\n")
        self.assertEqual(agent.tree_hash(), first)

    def test_hash_checkpoint_snapshot_include_code_hidden_by_global_excludes(self):
        home = pathlib.Path(self.temp.name, "global-home")
        (home / ".config/git").mkdir(parents=True)
        (home / ".config/git/ignore").write_text("*.py\n")
        excludes = home / "custom-excludes"
        excludes.write_text("*.py\n")
        config = home / ".gitconfig"
        for source, content in (("default", ""), ("core-excludes-file", f"[core]\n\texcludesFile = {excludes}\n")):
            with self.subTest(source=source):
                config.write_text(content)
                name = source + ".py"
                self.write(name, "print('included')\n")
                env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "XDG_CONFIG_HOME": str(home / ".config"),
                       "GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1"}
                # Establish that ordinary Git really would hide this new code.
                self.assertEqual(subprocess.check_output(["/usr/bin/git", "check-ignore", name],
                                                         cwd=self.root, env=env), (name + "\n").encode())
                with mock.patch.dict(os.environ, env):
                    expected = agent.tree_hash()
                    checkpoint = self.export()
                    published = agent.dispatch({"method": "snapshot", "identity": self.identity})
                self.assertEqual(self.git("rev-parse", published["head"] + "^{tree}").decode().strip(), expected)
                self.assertEqual(self.git("show", "HEAD:" + name), b"print('included')\n")
                bundle = pathlib.Path(self.temp.name, "global-excludes.bundle")
                bundle.write_bytes(base64.b64decode(checkpoint["bundle"]))
                self.git("fetch", "-q", str(bundle), agent.CHECKPOINT_REF)
                self.assertEqual(self.git("rev-parse", "FETCH_HEAD^{tree}").decode().strip(), expected)
                self.assertEqual(self.git("show", "FETCH_HEAD:" + name), b"print('included')\n")

    def test_shallow_snapshot_info_exclude_parity_without_filters_or_hooks(self):
        shallow = pathlib.Path(self.temp.name, "publication-shallow")
        self.git("clone", "-q", "--depth", "1", "--no-tags", self.root.as_uri(), str(shallow))
        self.root = shallow
        agent.ROOT = str(shallow)
        self.assertEqual(self.git("rev-parse", "--is-shallow-repository"), b"true\n")
        shallow_before = (self.root / ".git/shallow").read_bytes()
        with self.assertRaises(subprocess.CalledProcessError):
            self.git("cat-file", "-e", self.base)
        self.write(".gitattributes", "*.txt filter=unsafe\n*.py text eol=lf filter=unsafe\n")
        self.write("edit.txt", "published\n")
        code = b"print('included despite private excludes')\n"
        (self.root / "hidden.py").write_bytes(code.replace(b"\n", b"\r\n"))
        (self.root / ".git/info/exclude").write_text("hidden.py\n")
        self.assertEqual(self.git("check-ignore", "hidden.py"), b"hidden.py\n")
        excludes = pathlib.Path(self.temp.name, "local-excludes")
        excludes.write_text("hidden.py\n")
        self.git("config", "core.excludesFile", str(excludes))
        global_config = pathlib.Path(self.temp.name, "global-config")
        global_config.write_text(f"[core]\n\texcludesFile = {excludes}\n")
        self.git("config", "filter.unsafe.clean", "touch filter-ran; cat")
        self.git("config", "filter.unsafe.smudge", "touch filter-ran; cat")
        self.git("config", "core.fsmonitor", "touch fsmonitor-ran")
        self.git("config", "core.worktree", "/missing")
        bad_config = pathlib.Path(self.temp.name, "bad-publication-config")
        bad_config.write_text("invalid Git config\n")
        self.git("config", "include.path", str(bad_config))
        hooks = self.root / ".git/hooks"
        for name in ("pre-commit", "post-commit", "reference-transaction"):
            hook = hooks / name
            hook.write_text("#!/bin/sh\ntouch hook-ran\nexit 1\n")
            hook.chmod(0o755)
        config_before = (self.root / ".git/config").read_bytes()
        head_before = (self.root / ".git/HEAD").read_bytes()
        index_before = (self.root / ".git/index").read_bytes()
        with mock.patch.dict(os.environ, {"GIT_DIR": "/missing", "GIT_INDEX_FILE": "/missing",
                                         "GIT_CONFIG_GLOBAL": str(global_config), "HOME": self.temp.name,
                                         "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.fsmonitor",
                                         "GIT_CONFIG_VALUE_0": "touch env-ran", "GIT_OBJECT_DIRECTORY": "/missing"}):
            expected = agent.tree_hash()
            checkpoint = self.export(base_sha=self.head)
            self.assertEqual((self.root / ".git/HEAD").read_bytes(), head_before)
            self.assertEqual((self.root / ".git/index").read_bytes(), index_before)
            with agent.checkpoint_repository() as (_, _, _, head):
                self.assertEqual(head, self.head)
            published = agent.dispatch({"method": "snapshot", "identity": self.identity, "title": "Safe snapshot"})
            # An unchanged tree needs no identity and must not create a commit.
            unchanged = agent.dispatch({"method": "snapshot"})
        self.assertEqual(published["head"], unchanged["head"])
        self.assertEqual((self.root / ".git/config").read_bytes(), config_before)
        self.assertEqual((self.root / ".git/HEAD").read_bytes(), head_before)
        self.assertEqual((self.root / ".git/refs/heads/run").read_text(), published["head"] + "\n")
        self.assertEqual((self.root / ".git/shallow").read_bytes(), shallow_before)
        self.assertFalse((self.root / ".git/index.lock").exists())
        self.assertFalse((self.root / ".git/refs/heads/run.lock").exists())
        for name in ("filter-ran", "fsmonitor-ran", "hook-ran", "env-ran"):
            self.assertFalse((self.root / name).exists())
        with agent.checkpoint_repository() as (git, env, _, head):
            self.assertEqual(head, published["head"])
            self.assertEqual(git("rev-parse", head + "^{tree}").decode().strip(), expected)
            self.assertEqual(git("rev-list", "--parents", "-n", "1", head).decode().strip(), f"{head} {self.head}")
            env["GIT_INDEX_FILE"] = str(self.root / ".git/index")
            self.assertEqual(git("write-tree").decode().strip(), expected)
        # A normal receiver can import the shallow publication bundle against its
        # existing history, without rewriting that history or losing new files.
        receiver = pathlib.Path(self.temp.name, "receiver")
        self.git("clone", "-q", "--no-local", str(pathlib.Path(self.temp.name, "clone")), str(receiver))
        bundle = pathlib.Path(self.temp.name, "publication.bundle")
        bundle.write_bytes(base64.b64decode(published["bundle"]))
        self.assertEqual(self.git("bundle", "list-heads", str(bundle), cwd=receiver).decode(),
                         f'{published["head"]} HEAD\n')
        self.git("bundle", "verify", str(bundle), cwd=receiver)
        self.git("fetch", "-q", str(bundle), "HEAD", cwd=receiver)
        self.assertEqual(self.git("rev-parse", "FETCH_HEAD", cwd=receiver).decode().strip(), published["head"])
        self.assertEqual(self.git("rev-parse", "FETCH_HEAD^{tree}", cwd=receiver).decode().strip(), expected)
        self.assertEqual(self.git("show", "FETCH_HEAD:hidden.py", cwd=receiver), code)
        self.assertEqual(self.git("show", "FETCH_HEAD:edit.txt", cwd=receiver), b"published\n")
        self.assertEqual(self.git("show", "FETCH_HEAD:.gitattributes", cwd=receiver),
                         (self.root / ".gitattributes").read_bytes())
        # Inspect the actual checkpoint bundle too, not just the shared helper's
        # return value: its tree and normalized code must match publication.
        bundle.write_bytes(base64.b64decode(checkpoint["bundle"]))
        self.git("fetch", "-q", str(bundle), agent.CHECKPOINT_REF, cwd=receiver)
        self.assertEqual(self.git("rev-parse", "FETCH_HEAD", cwd=receiver).decode().strip(), checkpoint["checkpoint_sha"])
        self.assertEqual(self.git("rev-parse", "FETCH_HEAD^{tree}", cwd=receiver).decode().strip(), expected)
        self.assertEqual(self.git("show", "FETCH_HEAD:hidden.py", cwd=receiver), code)
        self.assertEqual(self.git("show", "FETCH_HEAD:edit.txt", cwd=receiver), b"published\n")
        self.assertEqual((self.root / "hidden.py").read_bytes(), code.replace(b"\n", b"\r\n"))

    def test_restore_reconciles_published_snapshot_without_rewriting_head_or_index(self):
        self.write("edit.txt", "saved before publication\n")
        self.write("new.txt", "captured untracked file\n")
        (self.root / "deleted.txt").unlink()
        data = self.export()
        self.git("add", "--all")
        self.git("commit", "-qm", "published snapshot")
        published_head = self.git("rev-parse", "HEAD").decode().strip()
        published_tree = self.git("rev-parse", "HEAD^{tree}")
        self.assertNotEqual(published_head, data["head_sha"])
        self.assertEqual(self.git("rev-parse", "HEAD^").decode().strip(), self.head)

        # Resume from the pushed shallow branch; the service must fetch both
        # pins separately, including the old checkpoint HEAD prerequisite.
        resumed = pathlib.Path(self.temp.name, "published-resume")
        self.git("clone", "-q", "--depth", "1", "--no-tags", self.root.as_uri(), str(resumed))
        self.root = resumed
        agent.ROOT = str(resumed)
        self.git("fetch", "-q", "--depth", "1", "origin", self.base)
        before = self.state()
        with self.assertRaises(RuntimeError):
            self.restore(data, published_head=published_head)
        self.assertEqual(self.state(), before)
        self.git("fetch", "-q", "--depth", "1", "origin", self.head)
        self.write("ignored-local", "keep local data\n")
        before = self.state()
        restored = self.restore(data, published_head=published_head)
        self.assertEqual(restored["checkpoint_sha"], data["checkpoint_sha"])
        self.assertEqual(self.state(), before)
        self.assertEqual(self.git("rev-parse", "HEAD^{tree}"), published_tree)
        self.assertEqual(self.git("diff", "HEAD", "--"), b"")
        self.assertEqual(self.git("ls-files", "--others", "--exclude-standard"), b"")
        self.assertEqual((resumed / "edit.txt").read_text(), "saved before publication\n")
        self.assertEqual((resumed / "new.txt").read_text(), "captured untracked file\n")
        self.assertFalse((resumed / "deleted.txt").exists())
        self.assertEqual((resumed / "ignored-local").read_text(), "keep local data\n")

    def test_canonical_snapshot_reconciles_pinned_checkpoint_and_preserves_state_fingerprint(self):
        (self.root / ".git/info/exclude").write_text("hidden.py\n")
        self.write("hidden.py", "print('captured despite private excludes')\n")
        expected_tree = agent.tree_hash()
        req = {"base_sha": self.base, "head_sha": self.head, "identity": self.identity}
        data = agent.checkpoint_tree(req, "private-history")
        published = agent.dispatch({"method": "snapshot", "identity": self.identity})
        self.assertEqual(self.git("rev-parse", "HEAD^{tree}").decode().strip(), expected_tree)
        self.assertEqual(self.git("show", "HEAD:hidden.py"), b"print('captured despite private excludes')\n")
        # Publication changes HEAD, not the pinned parent or canonical tree;
        # unchanged history must still deduplicate against the old fingerprint.
        self.assertEqual(agent.checkpoint_tree({**req, "previous_fingerprint": data["fingerprint"]},
                                              "private-history"), {"unchanged": True})
        changed = agent.checkpoint_tree({**req, "previous_fingerprint": data["fingerprint"]}, "new-history")
        self.assertIn("bundle", changed)
        self.assertNotEqual(changed["fingerprint"], data["fingerprint"])
        before = self.state()
        with self.assertRaisesRegex(RuntimeError, "HEAD does not match"):
            self.restore(data)
        self.restore(data, published_head=published["head"])
        self.assertEqual(self.state(), before)
        self.assertEqual(agent.tree_hash(), expected_tree)

    def test_restore_rejects_mismatched_published_head_or_tree_without_changes(self):
        self.write("edit.txt", "checkpoint tree\n")
        data = self.export()
        self.git("commit", "-qam", "published snapshot")
        published_head = self.git("rev-parse", "HEAD").decode().strip()
        before = self.state()
        for pin in (None, self.head, "not-a-sha"):
            with self.subTest(published_head=pin), self.assertRaises(RuntimeError):
                self.restore(data, published_head=pin)
            self.assertEqual(self.state(), before)
            self.assertEqual((self.root / "edit.txt").read_text(), "checkpoint tree\n")

        self.write("edit.txt", "different published tree\n")
        self.git("commit", "-qam", "later publication")
        current_head = self.git("rev-parse", "HEAD").decode().strip()
        before = self.state()
        for pin, error in ((published_head, "HEAD does not match"),
                           (current_head, "tree does not match")):
            with self.subTest(published_head=pin), self.assertRaisesRegex(RuntimeError, error):
                self.restore(data, published_head=pin)
            self.assertEqual(self.state(), before)
            self.assertEqual((self.root / "edit.txt").read_text(), "different published tree\n")

    def test_newly_staged_ignored_files_fail_closed_without_mutating_clone(self):
        self.write("ignored-tracked", "private work\n")
        self.git("add", "--force", "ignored-tracked")
        before = self.state()
        with self.assertRaisesRegex(RuntimeError, "Newly staged ignored files"):
            self.export()
        with self.assertRaisesRegex(RuntimeError, "Newly staged ignored files"):
            agent.tree_hash()
        with self.assertRaisesRegex(RuntimeError, "Newly staged ignored files"):
            agent.dispatch({"method": "snapshot", "identity": self.identity})
        self.assertEqual(self.state(), before)
        self.assertEqual((self.root / "ignored-tracked").read_text(), "private work\n")

    def test_config_environment_hooks_and_filters_cannot_redirect_or_execute(self):
        self.write(".gitattributes", "*.txt filter=unsafe\n")
        self.git("config", "filter.unsafe.clean", "touch filter-ran; cat")
        self.git("config", "filter.unsafe.smudge", "touch filter-ran; cat")
        self.git("config", "core.fsmonitor", "touch fsmonitor-ran")
        self.git("config", "core.worktree", str(pathlib.Path(self.temp.name, "elsewhere")))
        self.git("config", "include.path", str(pathlib.Path(self.temp.name, "bad-config")))
        pathlib.Path(self.temp.name, "bad-config").write_text("not a valid Git config\n")
        for name in ("pre-commit", "post-checkout", "reference-transaction"):
            hook = self.root / ".git/hooks" / name
            hook.write_text("#!/bin/sh\ntouch hook-ran\nexit 1\n")
            hook.chmod(0o755)
        self.write("edit.txt", "safe\n")
        with mock.patch.dict(os.environ, {"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.fsmonitor",
                                         "GIT_CONFIG_VALUE_0": "touch env-ran", "GIT_DIR": "/missing",
                                         "GIT_INDEX_FILE": "/missing", "GH_TOKEN": "secret",
                                         "GIT_OBJECT_DIRECTORY": "/missing", "GIT_CONFIG": "/missing"}):
            data = self.export()
            self.write("edit.txt", "head\n")
            (self.root / ".gitattributes").unlink()
            self.restore(data)
        self.assertEqual((self.root / "edit.txt").read_text(), "safe\n")
        for name in ("hook-ran", "filter-ran", "fsmonitor-ran", "env-ran"):
            self.assertFalse((self.root / name).exists())

    def test_shallow_clone_with_separately_pinned_base(self):
        shallow = pathlib.Path(self.temp.name, "shallow")
        self.git("clone", "-q", "--depth", "1", "--no-tags", self.root.as_uri(), str(shallow))
        self.git("fetch", "-q", "--depth", "1", "origin", self.base, cwd=shallow)
        self.root = shallow
        agent.ROOT = str(shallow)
        before = self.state()
        self.write("edit.txt", "shallow change\n")
        data = self.export()
        self.write("edit.txt", "head\n")
        self.restore(data)
        self.assertEqual((shallow / "edit.txt").read_text(), "shallow change\n")
        self.assertEqual(self.state(), before)
        # Prerequisites and refs remain unchanged even for an unchanged tree.
        self.write("edit.txt", "head\n")
        self.restore(self.export())
        self.assertEqual(self.state(), before)

    def test_pins_require_commit_objects_and_only_safe_clone_head_refs(self):
        self.git("tag", "-a", "-m", "base tag", "base-tag", self.base)
        tag = self.git("rev-parse", "base-tag").decode().strip()
        before = self.state()
        for base in (tag, "HEAD", "refs/heads/run", self.base + "^{commit}"):
            with self.subTest(base=base), self.assertRaisesRegex(RuntimeError, "Invalid checkpoint"):
                self.export(base_sha=base)
        for head in (tag, "HEAD", "refs/heads/run", self.base + "^{commit}", None, "1" * 40):
            with self.subTest(head=head), self.assertRaises(RuntimeError):
                self.export(head_sha=head)
        self.assertEqual(self.state(), before)

        # Ordinary packed branch refs are supported, but HEAD cannot select an
        # arbitrary ref namespace or escape through a loose-ref symlink.
        self.git("pack-refs", "--all")
        self.assertEqual(self.export()["head_sha"], self.head)
        head_file = self.root / ".git/HEAD"
        original = head_file.read_bytes()
        head_file.write_text("ref: refs/tags/base-tag\n")
        with self.assertRaisesRegex(RuntimeError, "Unsupported checkpoint HEAD"):
            self.export()
        head_file.write_text(tag + "\n")
        with self.assertRaisesRegex(RuntimeError, "Invalid checkpoint commit"):
            self.export()
        outside = pathlib.Path(self.temp.name, "outside-ref")
        outside.write_text(self.head + "\n")
        loose = self.root / ".git/refs/heads/escape"
        loose.symlink_to(outside)
        head_file.write_text("ref: refs/heads/escape\n")
        with self.assertRaisesRegex(RuntimeError, "Unsupported checkpoint repository layout"):
            self.export()
        head_file.write_bytes(original)
        self.assertEqual(outside.read_text(), self.head + "\n")

    def test_bundle_cannot_supply_a_missing_pinned_base(self):
        self.write("edit.txt", "saved\n")
        data = self.export()
        bundle = pathlib.Path(self.temp.name, "full.bundle")
        bundle.write_bytes(base64.b64decode(data["bundle"]))
        # Build an otherwise valid bundle containing the original history too.
        self.git("fetch", "-q", str(bundle), f"{agent.CHECKPOINT_REF}:{agent.CHECKPOINT_REF}")
        self.git("bundle", "create", str(bundle), agent.CHECKPOINT_REF)
        self.git("update-ref", "-d", agent.CHECKPOINT_REF)
        data["bundle"] = base64.b64encode(bundle.read_bytes()).decode()
        shallow = pathlib.Path(self.temp.name, "shallow")
        self.git("clone", "-q", "--depth", "1", "--no-tags", self.root.as_uri(), str(shallow))
        self.root = shallow
        agent.ROOT = str(shallow)
        before = self.state()
        with self.assertRaises(RuntimeError):
            self.restore(data)
        self.assertEqual(self.state(), before)
        self.assertEqual((shallow / "edit.txt").read_text(), "head\n")
        with self.assertRaises(subprocess.CalledProcessError):
            self.git("cat-file", "-e", self.base)

    def test_rejects_corrupt_forged_and_mismatched_checkpoints_without_applying(self):
        self.write("edit.txt", "saved\n")
        data = self.export()
        self.write("edit.txt", "head\n")
        raw = base64.b64decode(data["bundle"])
        forged = raw.replace(agent.CHECKPOINT_REF.encode(), b"refs/heads/forged")
        extra_ref = raw.replace(b"\n\nPACK", b"\n" + data["checkpoint_sha"].encode() + b" refs/heads/extra\n\nPACK")
        cases = [
            {"bundle": "not base64!"},
            {"bundle": base64.b64encode(raw[:-20]).decode()},
            {"bundle": base64.b64encode(forged).decode()},
            {"bundle": base64.b64encode(extra_ref).decode()},
            {"base_sha": self.head},  # Exists, but differs from committed metadata.
            {"base_sha": "1" * 40},
            {"head_sha": self.base},
            {"checkpoint_sha": self.head},
        ]
        before = self.state()
        for overrides in cases:
            with self.subTest(overrides=list(overrides)):
                with self.assertRaises((RuntimeError, ValueError)):
                    self.restore(data, **overrides)
                self.assertEqual(self.state(), before)
                self.assertEqual((self.root / "edit.txt").read_text(), "head\n")
        # A different clone HEAD must fail even when the checkpoint's metadata agrees.
        self.git("checkout", "-q", "--detach", self.base)
        with self.assertRaisesRegex(RuntimeError, "HEAD does not match"):
            self.restore(data)

    def test_restore_rejects_gitlinks_before_applying_any_changes(self):
        changed_blob = self.git("hash-object", "-w", "--stdin", input=b"checkpoint change\n").strip()
        entries = [entry for entry in self.git("ls-tree", "-z", self.head).split(b"\0")
                   if entry and not entry.endswith(b"\tedit.txt")]
        entries.append(b"100644 blob " + changed_blob + b"\tedit.txt")
        gitlink = b"160000 commit " + self.base.encode() + b"\tsubmodule\0"
        nested_tree = self.git("mktree", "-z", input=gitlink).strip()
        for location, entry in (("root", gitlink), ("nested", b"040000 tree " + nested_tree + b"\tvendor\0")):
            with self.subTest(location=location):
                tree = self.git("mktree", "-z", input=b"\0".join(entries) + b"\0" + entry).decode().strip()
                commit = self.git("commit-tree", tree, "-p", self.head,
                                  input=agent.checkpoint_message(self.base, self.head).encode()).decode().strip()
                self.git("update-ref", agent.CHECKPOINT_REF, commit)
                bundle = pathlib.Path(self.temp.name, "gitlink.bundle")
                self.git("bundle", "create", str(bundle), agent.CHECKPOINT_REF, "^" + self.head)
                self.git("update-ref", "-d", agent.CHECKPOINT_REF)
                before = self.state()
                with self.assertRaisesRegex(RuntimeError, "Checkpoint submodules are not supported"):
                    self.restore({"bundle": base64.b64encode(bundle.read_bytes()).decode(),
                                  "base_sha": self.base, "head_sha": self.head, "checkpoint_sha": commit})
                self.assertEqual(self.state(), before)
                self.assertEqual((self.root / "edit.txt").read_text(), "head\n")
                self.assertFalse((self.root / "submodule").exists())
                self.assertFalse((self.root / "vendor").exists())

    def test_restore_rejects_git_paths_and_existing_symlink_traversal(self):
        blob = self.git("rev-parse", "HEAD:edit.txt").strip()
        tree = self.git("mktree", "-z", input=b"100644 blob " + blob + b"\t.git\0").decode().strip()
        commit = self.git("commit-tree", tree, "-p", self.head,
                          input=agent.checkpoint_message(self.base, self.head).encode()).decode().strip()
        self.git("update-ref", agent.CHECKPOINT_REF, commit)
        bundle = pathlib.Path(self.temp.name, "unsafe.bundle")
        self.git("bundle", "create", str(bundle), agent.CHECKPOINT_REF, "^" + self.head)
        self.git("update-ref", "-d", agent.CHECKPOINT_REF)
        before = self.state()
        config = (self.root / ".git/config").read_bytes()
        with self.assertRaises(RuntimeError):
            self.restore({"bundle": base64.b64encode(bundle.read_bytes()).decode(),
                          "base_sha": self.base, "head_sha": self.head, "checkpoint_sha": commit})
        self.assertEqual(self.state(), before)
        self.assertEqual((self.root / ".git/config").read_bytes(), config)
        # Even a valid tree cannot follow a pre-existing worktree link into .git.
        (self.root / "added").mkdir()
        self.write("added/config", "malicious replacement\n")
        data = self.export()
        (self.root / "added/config").unlink()
        (self.root / "added").rmdir()
        (self.root / "added").symlink_to(".git", target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.restore(data)
        self.assertEqual(self.state(), before)
        self.assertEqual((self.root / ".git/config").read_bytes(), config)

    def test_size_caps_and_dirty_restore_fail_before_apply(self):
        self.write("edit.txt", "saved\n")
        with mock.patch.object(agent, "MAX_CHECKPOINT_BUNDLE", 16):
            with self.assertRaisesRegex(RuntimeError, "too large"):
                self.export()
        data = self.export()
        with mock.patch.object(agent, "MAX_CHECKPOINT_BUNDLE", 16), \
                mock.patch.object(agent.base64, "b64decode", side_effect=AssertionError("must not decode")):
            with self.assertRaisesRegex(RuntimeError, "too large"):
                self.restore(data)
        self.write("edit.txt", "conflicting local edits\n")
        before = self.state()
        with self.assertRaises(RuntimeError):
            self.restore(data)
        self.assertEqual(self.state(), before)
        self.assertEqual((self.root / "edit.txt").read_text(), "conflicting local edits\n")


if __name__ == "__main__":
    unittest.main()
