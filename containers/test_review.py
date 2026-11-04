"""Review controller boundary tests; no Docker or package downloads required."""
import base64
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tarfile
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("review_control", pathlib.Path(__file__).with_name("agent.py"))
control = importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class ReviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        control.ROOT = self.temp.name
        self.root = pathlib.Path(self.temp.name)
        self.env = {**os.environ, "GIT_AUTHOR_NAME": "fixture", "GIT_COMMITTER_NAME": "fixture",
                    "GIT_AUTHOR_EMAIL": "fixture@example.test", "GIT_COMMITTER_EMAIL": "fixture@example.test"}
        self.git("init", "-q")
        (self.root / "api/src").mkdir(parents=True)
        (self.root / "api/test").mkdir()
        (self.root / "api/src/value.ts").write_text("export const value = 0;\n")
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        self.base = self.git("rev-parse", "HEAD").decode().strip()
        self.finding = {"claim": "Wrong result", "file": "api/src/value.ts", "line": 1,
                        "proof_test_files": [{"path": "api/test/proof.test.ts", "contents": "test source"}],
                        "suggested_patch": "diff --git a/api/src/value.ts b/api/src/value.ts\n--- a/api/src/value.ts\n+++ b/api/src/value.ts\n@@ -1 +1 @@\n-export const value = 0;\n+export const value = 1;\n"}

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, env=self.env, stderr=subprocess.DEVNULL)

    def test_proof_uses_only_fixed_argv_and_applies_only_source_patch(self):
        with mock.patch.object(control, "review_prepare", return_value={"directories": ["api"]}), mock.patch.object(control, "review_run", return_value=(0, json.dumps({"testResults": [], "success": True}))) as run:
            result = control.review_proof({"finding": self.finding, "patched": True, "mode": "ask", "base_sha": self.base})
        self.assertEqual(result["exit_code"], 0)
        self.assertEqual((self.root / "api/src/value.ts").read_text(), "export const value = 1;\n")
        self.assertEqual(run.call_args.args[0], ["npm", "test", "--", "test/proof.test.ts", "--reporter=json"])
        self.assertEqual(self.git("show", "HEAD:api/src/value.ts"), b"export const value = 0;\n")

    def test_scope_rejects_traversal_existing_tests_symlinks_and_plan(self):
        for path in ("../proof.test.ts", "api/test/../../src/value.ts", ".git/config", "api/src/value.ts"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                finding = {**self.finding, "proof_test_files": [{"path": path, "contents": "x"}]}
                control.review_proof({"finding": finding, "mode": "allow", "base_sha": self.base})
        (self.root / "api/test/proof.test.ts").write_text("existing")
        with self.assertRaises(RuntimeError):
            control.review_proof({"finding": self.finding, "mode": "allow", "base_sha": self.base})
        with self.assertRaisesRegex(RuntimeError, "permission"):
            control.review_proof({"finding": self.finding, "mode": "plan", "base_sha": self.base})
        (self.root / "link").symlink_to(self.root / "api")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            control.review_path("link/test/new.test.ts")

    def test_provisioning_requires_pinned_supported_command_and_lock(self):
        with self.assertRaisesRegex(RuntimeError, "no supported base-pinned"):
            control.review_prepare({"base_sha": self.base})
        (self.root / "api/package.json").write_text(json.dumps({"scripts": {"test": "vitest run"}}))
        (self.root / "api/package-lock.json").write_text(json.dumps({"packages": {}}))
        self.git("add", ".")
        self.git("commit", "-qm", "test manifest")
        base = self.git("rev-parse", "HEAD").decode().strip()
        with mock.patch.object(control, "review_run", return_value=(1, "secret detail")):
            with self.assertRaisesRegex(RuntimeError, "dependency provisioning failed") as error:
                control.review_prepare({"base_sha": base})
            self.assertNotIn("secret detail", str(error.exception))
        (self.root / "api/package.json").write_text(json.dumps({"scripts": {"test": "echo fake"}}))
        with self.assertRaisesRegex(RuntimeError, "no supported"):
            control.review_prepare({"base_sha": base})

    def test_patch_cannot_change_tests_or_command_definitions(self):
        for path in ("api/test/other.test.ts", "api/test/fixtures/value.ts", "web/src/value.spec.mjs", "api/src/test-helper.ts", "api/package.json", ".github/workflows/test.yml"):
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("export const value = 0;\n")
            finding = {**self.finding, "file": path, "suggested_patch": self.finding["suggested_patch"].replace("api/src/value.ts", path)}
            with mock.patch.object(control, "review_prepare", return_value={"directories": ["api"]}), self.assertRaisesRegex(RuntimeError, "ordinary non-test"):
                control.review_proof({"finding": finding, "patched": True, "mode": "allow", "base_sha": self.base})
            (self.root / "api/test/proof.test.ts").unlink(missing_ok=True)

    def test_review_setup_real_copy_rejects_hardlinks_before_extracting(self):
        for hardlink in (True, False):
            body = io.BytesIO()
            with tarfile.open(fileobj=body, mode="w:gz") as tar:
                member = tarfile.TarInfo("copied.txt")
                member.size = 1
                tar.addfile(member, io.BytesIO(b"x"))
                if hardlink:
                    link = tarfile.TarInfo("linked.txt")
                    link.type = tarfile.LNKTYPE
                    link.linkname = "copied.txt"
                    tar.addfile(link)
            request = {"method": "setup", "archive": base64.b64encode(body.getvalue()).decode(), "review": True}
            if hardlink:
                with self.assertRaisesRegex(RuntimeError, "hard links"):
                    control.dispatch(request)
                self.assertFalse((self.root / "copied.txt").exists())
            else:
                control.dispatch(request)
                self.assertEqual((self.root / "copied.txt").read_text(), "x")

    def test_execution_scrubs_credentials_and_enforces_timeout(self):
        with mock.patch.dict(os.environ, {"GH_TOKEN": "secret", "GOND_AGENT_RELAY_TOKEN": "secret", "GOND_AGENT_OTHER": "secret"}):
            code, output = control.review_run(["/usr/bin/python3", "-c", "import os,json; print(json.dumps(dict(os.environ)))"], self.root, 2)
        self.assertEqual(code, 0)
        env = json.loads(output)
        self.assertNotIn("GH_TOKEN", env)
        self.assertFalse(any(key.startswith("GOND_AGENT_") for key in env))
        with self.assertRaisesRegex(RuntimeError, "budget"):
            control.review_run(["/usr/bin/python3", "-c", "import time; time.sleep(5)"], self.root, 0.05)

    def test_base_diff_isolated_from_git_config_and_symlink_docs_are_not_waived(self):
        (self.root / "symlink.md").symlink_to("api/src/value.ts")
        result = control.dispatch({"method": "review_diff", "base_sha": self.base})
        self.assertIn("symlink.md", result["files"])
        self.assertFalse(result["docs_only"])
        self.assertIn("symlink.md", result["diff"])


if __name__ == "__main__":
    unittest.main()
