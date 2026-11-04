#!/usr/bin/env python3
"""Mandatory built-image smoke: real Chromium suites and both compiled-worker smokes.

CI invokes this inside the finished worker image, sequentially under the worker's
2 GiB memory limit, read-only root and non-root security restrictions. Kept out
of Docker build layers so smoke results are not cached with the image.
"""
import os
import pathlib
import subprocess
import sys


def main():
    scripts = pathlib.Path(__file__).resolve().parent
    browser = scripts / "browser"
    if not browser.is_dir():
        browser = pathlib.Path("/opt/gond-agent-browser")
    env = {key: value for key, value in os.environ.items()
           if key not in {"GH_TOKEN", "GITHUB_TOKEN"} and not key.startswith("GOND_AGENT_")}
    commands = [
        ["node", "--test", "--test-concurrency=1", str(browser / "browser.test.cjs")],
        ["node", "--test", "--test-concurrency=1", str(browser / "persistent.chromium.test.cjs")],
        [sys.executable, str(scripts / "smoke-worker.py")],
        [sys.executable, str(scripts / "smoke-browser.py")],
    ]
    for command in commands:
        subprocess.run(command, env=env, check=True, timeout=240)
    print("Worker-image smoke passed: both Chromium suites and both compiled-worker smokes", flush=True)


if __name__ == "__main__":
    main()
