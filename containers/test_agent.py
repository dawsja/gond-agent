import base64
import contextlib
import http.server
import json
import socket
import threading
import time
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("agent", pathlib.Path(__file__).with_name("agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        agent.ROOT = self.temp.name
        agent.events = []

    def tearDown(self):
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
                connection.sendall(b"POST /v1/search HTTP/1.1\r\nHost: localhost\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
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
import json, subprocess
from agent import worker_env
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
        added = set(env) - set(os.environ)
        self.assertEqual(added, {"GOND_AGENT_API_URL", "GOND_AGENT_MODEL", "GOND_AGENT_EFFORT", "GOND_AGENT_HOME", "GOND_AGENT_INITIAL_PLAN", "GOND_AGENT_PLAN_REMINDER_EVERY", "GOND_AGENT_PLAN_NUDGE_LIMIT", "GOND_AGENT_INTERACTIVE", "GOND_AGENT_QUESTION_WAIT_MINUTES"})


if __name__ == "__main__":
    unittest.main()
