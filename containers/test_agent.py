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
        self.assertEqual(added, {"GOND_AGENT_RELAY_TOKEN", "GOND_AGENT_API_URL", "GOND_AGENT_MODEL", "GOND_AGENT_EFFORT", "GOND_AGENT_HOME", "GOND_AGENT_INITIAL_PLAN", "GOND_AGENT_PLAN_REMINDER_EVERY", "GOND_AGENT_PLAN_NUDGE_LIMIT", "GOND_AGENT_INTERACTIVE", "GOND_AGENT_QUESTION_WAIT_MINUTES"} - set(os.environ))

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


if __name__ == "__main__":
    unittest.main()
