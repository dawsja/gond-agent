"""Publication reconstructs exactly the signed red tree, including after restore."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("repro_agent", pathlib.Path(__file__).with_name("agent.py"))
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)


class ReproPublicationTest(unittest.TestCase):
    identity = {"name": "fixture", "email": "fixture@example.test"}

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.old_root = agent.ROOT
        agent.ROOT = str(self.root)
        self.git("init", "-q", "-b", "run")
        (self.root / "source.js").write_text("module.exports = 1;\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip().decode()
        (self.root / "regression.test.js").write_text("assert.equal(value, 2);\n")
        self.red = agent.tree_hash()
        self.stage = {"base": self.base, "tree": self.red, "test_files": ["regression.test.js"]}

    def tearDown(self):
        agent.ROOT = self.old_root
        self.temp.cleanup()

    def git(self, *args):
        return subprocess.check_output(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", *args], cwd=self.root,
                                      env={"PATH": "/usr/bin:/bin", "HOME": self.temp.name, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                                           "GIT_AUTHOR_NAME": "fixture", "GIT_AUTHOR_EMAIL": "fixture@example.test",
                                           "GIT_COMMITTER_NAME": "fixture", "GIT_COMMITTER_EMAIL": "fixture@example.test"}, stderr=subprocess.PIPE)

    def publish(self, stage=None):
        return agent.snapshot_tree({"title": "Fix\u202e regression\x00\nTrailer: forged", "identity": self.identity,
                                    "repro_stage": self.stage if stage is None else stage})

    def test_immediate_stage_preserves_production_worktree_and_final_title(self):
        (self.root / "source.js").write_text("module.exports = 2;\n")
        staged = agent.snapshot_tree({"title": "Fix regression", "identity": self.identity,
                                      "repro_stage": self.stage, "stage_only": True})
        self.assertTrue(staged["staged"])
        self.assertNotIn("bundle", staged)
        self.assertEqual(self.git("show", "HEAD:source.js"), b"module.exports = 1;\n")
        self.assertEqual((self.root / "source.js").read_text(), "module.exports = 2;\n")
        self.assertEqual(self.git("diff", "--cached", "--name-only").strip(), b"")
        agent.snapshot_tree({"title": "Fix regression", "identity": self.identity})
        self.assertEqual(self.git("show", "-s", "--format=%s", "HEAD").strip(), b"Fix regression")
        self.assertEqual(self.git("show", "-s", "--format=%s", "HEAD^").strip(), b"Add failing test for: Fix regression")

    def test_tests_only_staging_commit_sanitized_title_then_final_fix(self):
        (self.root / "source.js").write_text("module.exports = 2;\n")
        published = self.publish()
        self.assertEqual(self.git("rev-parse", "HEAD").strip().decode(), published["head"])
        self.assertEqual(self.git("show", "HEAD^:source.js"), b"module.exports = 1;\n")
        self.assertEqual(self.git("diff", "--name-only", "HEAD^^", "HEAD^").strip(), b"regression.test.js")
        self.assertEqual(self.git("diff", "--name-only", "HEAD^", "HEAD").strip(), b"source.js")
        self.assertEqual(self.git("show", "-s", "--format=%B", "HEAD^").strip(), b"Add failing test for: Fix regression")
        self.assertEqual(self.git("rev-parse", "HEAD^^").strip().decode(), self.base)
        self.assertIn("bundle", published)

    def test_checkpoint_tree_restore_preserves_order_without_unpublished_history(self):
        checkpoint = agent.checkpoint_tree({"base_sha": self.base, "head_sha": self.base, "identity": self.identity})
        (self.root / "regression.test.js").unlink()
        agent.restore_checkpoint({k: checkpoint[k] for k in ("bundle", "base_sha", "head_sha", "checkpoint_sha")})
        (self.root / "source.js").write_text("module.exports = 2;\n")
        self.publish()
        self.assertEqual(self.git("rev-parse", "HEAD^^").strip().decode(), self.base)
        self.assertEqual(self.git("rev-parse", "HEAD^^{tree}").strip().decode(), self.red)

    def test_changed_test_or_bad_stage_falls_back_to_single_commit(self):
        (self.root / "source.js").write_text("module.exports = 2;\n")
        (self.root / "regression.test.js").write_text("test changed after red\n")
        self.publish()
        self.assertEqual(self.git("rev-parse", "HEAD^").strip().decode(), self.base)

    def test_raw_stage_with_matching_production_tree_is_rejected(self):
        (self.root / "source.js").write_text("module.exports = 2;\n")
        forged = {**self.stage, "tree": agent.tree_hash(), "test_files": ["source.js", "regression.test.js"]}
        staged = agent.snapshot_tree({"title": "Fix", "identity": self.identity, "repro_stage": forged, "stage_only": True})
        self.assertEqual(staged, {"staged": False})
        self.assertEqual(self.git("rev-parse", "HEAD").strip().decode(), self.base)

    def test_repro_policy_is_packaged_from_the_rust_source(self):
        source = pathlib.Path(__file__).resolve().parents[1]
        policy = source / "runner/repro-test-paths.json"
        self.assertTrue(policy.is_file(), "one shared repro policy is required")
        dockerfile = (source / "Dockerfile").read_text()
        self.assertIn("COPY runner/repro-test-paths.json /opt/gond-agent/repro-test-paths.json", dockerfile)
        for path in ["a.test.ts", "nested/test_a.py", "pkg/a_test.go", "pkg/tests/helper.rs"]:
            self.assertTrue(agent.repro_test_path(path), path)
        for path in ["source.js", "tests/config.toml", ".git/a.test.ts", "../a.test.ts"]:
            self.assertFalse(agent.repro_test_path(path), path)

    def test_non_test_delta_cannot_be_inserted_in_the_test_commit(self):
        (self.root / "source.js").write_text("module.exports = 2;\n")
        self.publish({**self.stage, "test_files": ["regression.test.js", "source.js"]})
        self.assertEqual(self.git("rev-parse", "HEAD^").strip().decode(), self.base)


if __name__ == "__main__":
    unittest.main()
