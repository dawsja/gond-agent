#!/usr/bin/env python3
"""Exercise optional worker MCP tools without inference."""
import json
import pathlib
import subprocess
import tempfile

with tempfile.TemporaryDirectory(prefix="gond-native-tools-") as directory:
    root = pathlib.Path(directory)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "Initial"], cwd=root, check=True)
    process = subprocess.Popen(["/usr/local/bin/gond-agent-worker", "--tool-server"], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    sequence = 0
    def call(name, arguments):
        global sequence
        sequence += 1
        process.stdin.write(json.dumps({"jsonrpc": "2.0", "id": sequence, "method": "tools/call", "params": {"name": name, "arguments": arguments}}) + "\n")
        process.stdin.flush()
        return json.loads(process.stdout.readline())["result"]
    try:
        assert not call("bash", {"command": "python3 -c 'assert 2 + 2 == 4'"})["isError"]
        assert not call("bash", {"command": "git diff HEAD -- && git status --short"})["isError"]
        print("Native MCP smoke passed: optional shell and diff tools")
    finally:
        process.stdin.close()
        process.wait(timeout=10)
