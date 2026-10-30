#!/usr/bin/env python3
"""Exercise the MCP completion gate used by subscription agents without inference."""
import json
import pathlib
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix="gond-native-tools-") as directory:
    root = pathlib.Path(directory)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "Initial"], cwd=root, check=True)
    pathlib.Path("/tmp/gond-turn").write_text("native-tool-smoke")
    process = subprocess.Popen(["/usr/local/bin/gond-agent-worker", "--tool-server"], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    sequence = 0
    def call(name, arguments):
        global sequence
        sequence += 1
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": sequence, "method": "tools/call", "params": {"name": name, "arguments": arguments}}) + "\n")
        process.stdin.flush()
        return json.loads(process.stdout.readline())["result"]
    try:
        assert call("finish_review", {})["isError"]
        assert not call("bash", {"command": "python3 -c 'assert 2 + 2 == 4'"})["isError"]
        check_id = str(sequence)
        assert not call("bash", {"command": "git diff HEAD -- && git status --short"})["isError"]
        diff_id = str(sequence)
        verdict = call("finish_review", {"understanding": "Traced the repository", "design": "Use the existing approach", "checks": [check_id], "diff_call_id": diff_id, "review": "Inspected the final diff", "web_app": False})
        assert not verdict["isError"], verdict
        assert subprocess.run(["/usr/local/bin/gond-agent-worker", "--check-review"], cwd=root, capture_output=True).returncode == 0
        root.joinpath("changed.txt").write_text("An edit after self-review")
        assert subprocess.run(["/usr/local/bin/gond-agent-worker", "--check-review"], cwd=root, capture_output=True).returncode != 0
        print("Native MCP smoke passed: checks, review, and stale-evidence rejection")
    finally:
        process.stdin.close()
        process.wait(timeout=10)
        for name in ["/tmp/gond-reviewed", "/tmp/gond-turn"]:
            pathlib.Path(name).unlink(missing_ok=True)
