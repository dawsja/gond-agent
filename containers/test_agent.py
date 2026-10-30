import base64
import importlib.util
import io
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
        data = agent.dispatch({"method": "snapshot", "title": "Add hello"})
        bundle = pathlib.Path(agent.ROOT, "saved.bundle")
        bundle.write_bytes(base64.b64decode(data["bundle"]))
        self.assertEqual(len(data["head"]), 40)
        git("bundle", "verify", str(bundle))
        self.assertEqual(git("show", "HEAD:a.txt"), b"hello")
        self.assertFalse(pathlib.Path(agent.ROOT, "hook-ran").exists())

    def test_event_cursor_is_bounded_and_validated(self):
        agent.events = [{"n": i} for i in range(250)]
        batch = agent.dispatch({"method": "events", "after": 10})
        self.assertEqual(len(batch["events"]), 200)
        self.assertEqual(batch["events"][0]["n"], 10)
        with self.assertRaises(RuntimeError):
            agent.dispatch({"method": "events", "after": -1})


if __name__ == "__main__":
    unittest.main()
