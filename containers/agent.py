#!/usr/bin/env python3
"""Container control + loopback model relay. Only Docker's attached stdio reaches the host."""
import base64
import contextlib
import hmac
import hashlib
import http.server
import io
import json
import os
import pathlib
import queue
import re
import secrets
import tempfile
import select
import socket
import time
import signal
import subprocess
import sys
import tarfile
import threading
import traceback
import uuid

ROOT = "/workspace/repo"
MAX_FRAME = 256 * 1024 * 1024
MAX_CHECKPOINT_BUNDLE = 64 * 1024 * 1024
MAX_STATE = 4 * 1024 * 1024
STATE_TIMEOUT = 120
state_lock = threading.Lock()
state_waiters = {}  # At most one RPC, separate from worker/event/model locks.
CHECKPOINT_REF = "refs/gond-agent/checkpoint"
checkpoint_lock = threading.Lock()
capture_lock = threading.Lock()  # No capture/release queue and no overlapping tree/state pairs.
held_boundary = None  # (worker, opaque controller boundary ID, runner boundary ID)
worker = None
relay_token = None
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


def command(args, timeout=120, env=None):
    result = subprocess.run(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=env)
    if result.returncode:
        print("Workspace command failed:", args[0], result.stderr.decode(errors="replace")[-1000:], file=sys.stderr)
        raise RuntimeError("The workspace command failed.")
    return result.stdout


def checkpoint_sha(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{40}", value):
        raise RuntimeError("Invalid checkpoint revision.")
    return value


def checkpoint_commit(git, sha):
    # Pins name commits themselves, not tags that Git could silently peel.
    if git("cat-file", "-t", sha).strip() != b"commit":
        raise RuntimeError("Invalid checkpoint commit.")


def clone_git_file(gitdir, name):
    path = gitdir / name
    if path.is_symlink() or not path.resolve().is_relative_to(gitdir):
        raise RuntimeError("Unsupported checkpoint repository layout.")
    return path


def clone_head(gitdir, git):
    """Resolve only ordinary clone HEADs, without ever loading checkout configuration."""
    head = clone_git_file(gitdir, "HEAD").read_text().strip()
    if head.startswith("ref: "):
        ref = head[5:]
        if not ref.startswith("refs/heads/"):
            raise RuntimeError("Unsupported checkpoint HEAD.")
        git("check-ref-format", ref)
        loose = clone_git_file(gitdir, ref)
        if loose.exists():
            head = loose.read_text().strip()
        else:
            packed = clone_git_file(gitdir, "packed-refs")
            matches = [line.split()[0] for line in packed.read_text().splitlines()
                       if len(line.split()) == 2 and line.split()[1] == ref] if packed.exists() else []
            if len(matches) != 1:
                raise RuntimeError("Missing checkpoint HEAD.")
            head = matches[0]
    return checkpoint_sha(head)


@contextlib.contextmanager
def checkpoint_repository():
    """Private Git config, refs, objects and index; the clone is only an object source.

    In particular, do not run Git with the clone's git-dir: even local config can
    install clean/smudge filters, includes, helpers or an alternate worktree.
    No inherited Git variables, credentials, user config or writable tool PATH.
    """
    root = pathlib.Path(ROOT).resolve()
    gitdir = root / ".git"
    if gitdir.is_symlink() or not gitdir.is_dir() or (gitdir / "objects").is_symlink():
        raise RuntimeError("Unsupported checkpoint repository layout.")
    with tempfile.TemporaryDirectory(prefix="gond-checkpoint-", dir="/tmp") as directory:
        scratch = pathlib.Path(directory)
        env = {"PATH": "/usr/bin:/bin", "HOME": directory, "LC_ALL": "C",
               "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_SYSTEM": "/dev/null",
               "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0",
               "GIT_NO_REPLACE_OBJECTS": "1", "GIT_TERMINAL_PROMPT": "0",
               "GIT_ALLOW_PROTOCOL": "file", "GIT_ATTR_NOSYSTEM": "1"}

        def git(*args, input=None, output=None):
            result = subprocess.run(
                ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
                 "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null",
                 "-c", "commit.gpgsign=false", "-c", "credential.helper=",
                 "-c", "transfer.fsckObjects=true", "-c", "fetch.fsckObjects=true", *args],
                cwd=root, env=env, input=input, stdout=output or subprocess.PIPE,
                stderr=subprocess.PIPE, timeout=120)
            if result.returncode:
                # Never echo untrusted repository diagnostics (or embedded secrets).
                raise RuntimeError("The checkpoint Git operation failed.")
            return result.stdout

        git("init", "--quiet", "--template=", str(scratch / "repo"))
        env.update({"GIT_DIR": str(scratch / "repo/.git"), "GIT_WORK_TREE": str(root),
                    "GIT_INDEX_FILE": str(scratch / "index"),
                    "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(gitdir / "objects")})
        excludes = clone_git_file(gitdir, "info/exclude")
        if excludes.exists():
            target = scratch / "repo/.git/info/exclude"
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(excludes.read_bytes())
        shallow = clone_git_file(gitdir, "shallow")
        if shallow.exists():
            content = shallow.read_text()
            for line in content.splitlines():
                checkpoint_sha(line)
            (scratch / "repo/.git/shallow").write_text(content)
        head = clone_head(gitdir, git)
        checkpoint_commit(git, head)
        yield git, env, scratch, head


def workspace_quiescent():
    """No tool/background processes may outlive the clean observation and snapshot.

    Workers have a private PID namespace: only init, this controller and the idle
    runner may remain. Count detached/reparented processes too; unknown fails closed.
    """
    allowed = {1, os.getpid()}
    if worker is not None:
        allowed.add(worker.pid)
    try:
        return all(not entry.name.isdecimal() or int(entry.name) in allowed for entry in pathlib.Path("/proc").iterdir())
    except OSError:
        return False


def workspace_state():
    """Fail-closed release evidence using private Git config/index, without staging edits."""
    with checkpoint_lock, checkpoint_repository() as (git, env, _, head):
        gitdir = pathlib.Path(ROOT).resolve() / ".git"
        # Publication exports HEAD only. Stashes, tags/notes and commits on other
        # local branches must not disappear just because the current tree is clean.
        refs = {}
        packed = clone_git_file(gitdir, "packed-refs")
        if packed.exists():
            for line in packed.read_text().splitlines():
                if line and not line.startswith(("#", "^")):
                    sha, name = line.split()
                    refs[name] = sha
        root = clone_git_file(gitdir, "refs")
        for entry in root.rglob("*"):
            entry = clone_git_file(gitdir, str(entry.relative_to(gitdir)))
            if entry.is_file():
                name = entry.relative_to(gitdir).as_posix()
                if not name.startswith("refs/remotes/"):
                    refs[name] = entry.read_text().strip()
        for name, sha in refs.items():
            if name.startswith("refs/remotes/"):
                continue
            if not name.startswith("refs/heads/") or git("rev-list", "--max-count=1", checkpoint_sha(sha), "--not", head).strip():
                return {"head": head, "clean": False}
        # Parent snapshots cannot preserve dirty submodule contents. Be conservative
        # even for apparently clean gitlinks, rather than trust submodule config.
        submodules = any(entry.startswith(b"160000 ") for entry in git("ls-tree", "-rz", head).split(b"\0"))
        if submodules or not workspace_quiescent():
            return {"head": head, "clean": False}
        index = clone_git_file(gitdir, "index")
        if not index.exists():
            return {"head": head, "clean": False}
        private_index = env["GIT_INDEX_FILE"]
        try:
            env["GIT_INDEX_FILE"] = str(index)
            staged = git("diff", "--cached", "--no-ext-diff", "--name-only", head, "--")
        finally:
            env["GIT_INDEX_FILE"] = private_index
        git("read-tree", head)
        git("add", "--all", "--", str(pathlib.Path(ROOT).resolve()))
        tree = git("write-tree").strip()
        return {"head": head, "clean": not staged and tree == git("rev-parse", head + "^{tree}").strip() and workspace_quiescent()}


def checkpoint_message(base, head):
    return f"Gond Agent checkpoint\n\nbase_sha: {base}\nhead_sha: {head}\n"


def checkpoint_tree(req, state_digest=None):
    """Export the working tree, not the staging area; never publish this commit."""
    base = checkpoint_sha(req.get("base_sha"))
    identity = req.get("identity", {})
    if any(not isinstance(identity.get(key), str) or not identity[key].strip() or
           any(c in identity[key] for c in "\r\n\0<>") for key in ("name", "email")):
        raise RuntimeError("A connected GitHub commit identity is required.")
    with checkpoint_lock, checkpoint_repository() as (git, env, scratch, head):
        checkpoint_commit(git, base)
        # Production pins an upstream-recoverable checkout/publication commit,
        # not a possibly unpublished local HEAD. The tree still starts at HEAD.
        parent = checkpoint_sha(req["head_sha"]) if "head_sha" in req else head
        checkpoint_commit(git, parent)
        # Staging metadata is deliberately not restored. A newly force-added
        # ignored file would otherwise vanish from export or later publication.
        index = clone_git_file(pathlib.Path(ROOT).resolve() / ".git", "index")
        if index.exists():
            temporary_index = env["GIT_INDEX_FILE"]
            try:
                env["GIT_INDEX_FILE"] = str(index)
                ignored = set(git("ls-files", "--cached", "--ignored", "--exclude-standard", "-z").split(b"\0")) - {b""}
            finally:
                env["GIT_INDEX_FILE"] = temporary_index
            tracked = set(git("ls-tree", "-rz", "--name-only", head).split(b"\0"))
            if ignored - tracked:
                raise RuntimeError("Newly staged ignored files are not supported by checkpoints.")
        git("read-tree", head)
        git("add", "--all", "--", str(pathlib.Path(ROOT).resolve()))
        tree = git("write-tree").decode().strip()
        fingerprint = hashlib.sha256(f"{base}:{parent}:{tree}:{state_digest}".encode()).hexdigest() if state_digest else None
        if fingerprint and fingerprint == req.get("previous_fingerprint"):
            return {"unchanged": True}
        env.update({f"GIT_{role}_{key}": identity[field] for role in ("AUTHOR", "COMMITTER")
                    for key, field in (("NAME", "name"), ("EMAIL", "email"))})
        # Stable internal metadata; publication still uses the normal snapshot path.
        env.update({"GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z"})
        commit = git("commit-tree", tree, "-p", parent, input=checkpoint_message(base, parent).encode()).decode().strip()
        git("update-ref", CHECKPOINT_REF, commit)
        bundle = scratch / "checkpoint.bundle"
        # Exclude pinned history, including shallow boundaries. Only the parent
        # is a prerequisite; the separately pinned base must also exist on restore.
        git("bundle", "create", "--version=2", str(bundle), CHECKPOINT_REF, "^" + parent)
        if bundle.stat().st_size > MAX_CHECKPOINT_BUNDLE:
            raise RuntimeError("The checkpoint bundle is too large.")
        return {**({"fingerprint": fingerprint} if fingerprint else {}), "bundle": base64.b64encode(bundle.read_bytes()).decode(),
                "base_sha": base, "head_sha": parent, "checkpoint_sha": commit}


def restore_checkpoint(req):
    """Validate first, then apply a tree-only patch in the worker, never host Git.

    The caller must supply the persisted base/HEAD pins and optional published
    HEAD from its authenticated journal, not trust bundle metadata.
    Failure is the seam for a caller to fall back to its regular fresh checkout.
    """
    base = checkpoint_sha(req.get("base_sha"))
    head = checkpoint_sha(req.get("head_sha"))
    commit = checkpoint_sha(req.get("checkpoint_sha"))
    published_head = req.get("published_head")
    if published_head is not None:
        published_head = checkpoint_sha(published_head)
    encoded = req.get("bundle")
    if not isinstance(encoded, str) or len(encoded) > 4 * ((MAX_CHECKPOINT_BUNDLE + 2) // 3):
        raise RuntimeError("The checkpoint bundle is too large.")
    body = base64.b64decode(encoded, validate=True)
    if not body or len(body) > MAX_CHECKPOINT_BUNDLE:
        raise RuntimeError("Invalid checkpoint bundle size.")
    with worker_lock, checkpoint_lock:
        if worker and worker.poll() is None:
            raise RuntimeError("The worker is already running.")
        with checkpoint_repository() as (git, _, scratch, current_head):
            if current_head != head and current_head != published_head:
                raise RuntimeError("The checkpoint HEAD does not match the clone.")
            checkpoint_commit(git, base)
            # The pinned old HEAD must already exist, never come from the bundle.
            checkpoint_commit(git, head)
            bundle = scratch / "checkpoint.bundle"
            bundle.write_bytes(body)
            expected = f"{commit} {CHECKPOINT_REF}\n".encode()
            if git("bundle", "list-heads", str(bundle)) != expected:
                raise RuntimeError("Invalid checkpoint bundle references.")
            git("bundle", "verify", str(bundle))
            git("fetch", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules",
                str(bundle), f"{CHECKPOINT_REF}:{CHECKPOINT_REF}")
            checkpoint_commit(git, commit)
            git("fsck", "--strict", "--no-reflogs", "--no-dangling", commit, head, base)
            if git("rev-list", "--parents", "-n", "1", commit).decode().strip() != f"{commit} {head}":
                raise RuntimeError("Invalid checkpoint parent.")
            if git("show", "-s", "--format=%B", commit).decode().strip() != checkpoint_message(base, head).strip():
                raise RuntimeError("The checkpoint pins do not match.")
            # Publication may have committed this exact checkpoint tree before
            # the next capture. Reconcile only that journal-authenticated HEAD.
            if (current_head != head and
                    git("rev-parse", commit + "^{tree}") != git("rev-parse", current_head + "^{tree}")):
                raise RuntimeError("The checkpoint tree does not match the published HEAD.")
            for entry in git("ls-tree", "-rz", commit).split(b"\0"):
                if not entry:
                    continue
                metadata, path = entry.split(b"\t", 1)
                if metadata.split(b" ", 1)[0] == b"160000":
                    raise RuntimeError("Checkpoint submodules are not supported.")
                if any(part.lower() == b".git" or part in (b"", b".", b"..") for part in path.split(b"/")):
                    raise RuntimeError("Unsafe checkpoint path.")
            git("read-tree", current_head)
            patch = scratch / "tree.patch"
            with patch.open("wb") as output:
                git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--binary", "--full-index",
                    current_head, commit, "--", output=output)
            if patch.stat().st_size:
                # No --index/--cached, reset or checkout: the real index, HEAD,
                # refs and ignored files retain ordinary publication semantics.
                git("apply", "--check", "--binary", str(patch))
                git("apply", "--binary", str(patch))
            return {"base_sha": base, "head_sha": head, "checkpoint_sha": commit}


def state_json(state):
    """Measure only the canonical, compact UTF-8 state, not its RPC envelope."""
    try:
        body = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        if len(body.encode("utf-8")) > MAX_STATE:
            raise ValueError()
        return body
    except (ValueError, TypeError, UnicodeError, RecursionError):
        # Serialization diagnostics can contain private payloads.
        raise RuntimeError("Invalid or oversized worker state.") from None


def fail_state_waiters(source):
    global held_boundary
    # Caller holds worker_lock; always acquire locks in worker -> state order.
    if held_boundary and held_boundary[0] is source:
        held_boundary = None
    with state_lock:
        for key, (owner, _, replies) in list(state_waiters.items()):
            if owner is source:
                state_waiters.pop(key)
                with contextlib.suppress(queue.Full):
                    replies.put_nowait(None)


def write_state_frame(source, frame, deadline):
    """Bound pipe backpressure too; worker_lock serializes this with ordinary sends."""
    body = memoryview((json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8"))
    fd = source.stdin.fileno()
    blocking = os.get_blocking(fd)
    os.set_blocking(fd, False)
    try:
        while body:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [fd], [], remaining)[1]:
                raise TimeoutError()
            try:
                written = os.write(fd, body[:4096])
                body = body[written:]
            except BlockingIOError:
                continue
    finally:
        os.set_blocking(fd, blocking)


def state_rpc(req, expected_worker=None):
    """Export returns {state: ...}; import returns True. Correlation stays internal."""
    global worker, relay_token
    operation = req["method"]
    frame = {"type": operation, "request_id": uuid.uuid4().hex}
    if operation == "checkpoint.release":
        frame["boundary_id"] = req.get("boundary_id")
    else:
        frame.update({"run_id": req.get("run_id"), "owner_id": req.get("owner_id")})
    if operation == "export_state":
        for field in ("quiescent", "boundary_id", "hold"):
            if field in req:
                frame[field] = req[field]
    if operation == "import_state":
        if "state" not in req:
            raise RuntimeError("Missing worker state.")
        state_json(req["state"])
        frame["state"] = req["state"]
    replies = queue.Queue(maxsize=1)
    key = frame["request_id"]
    deadline = time.monotonic() + STATE_TIMEOUT
    try:
        with worker_lock:
            if not worker or worker.poll() is not None or (expected_worker is not None and worker is not expected_worker):
                raise RuntimeError("The worker is not running.")
            with state_lock:
                if state_waiters:
                    raise RuntimeError("A worker state operation is already pending.")
                state_waiters[key] = (worker, operation, replies)
            try:
                write_state_frame(worker, frame, deadline)
            except Exception:
                # A partial JSONL frame cannot be reused safely. Discard this worker
                # rather than concatenate a later interrupt/import onto private state.
                source, worker, relay_token = worker, None, None
                fail_state_waiters(source)
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(source.pid, signal.SIGKILL)
                source.wait(timeout=5)
                raise RuntimeError("The worker state request failed.") from None
        # Never hold worker_lock while waiting: interrupts, drains and replacement
        # must remain available even when the runner cannot reach an export seam.
        try:
            reply = replies.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty:
            raise RuntimeError("The worker state request timed out.") from None
        if not reply or reply["type"] == "state.error":
            raise RuntimeError("The worker state request failed.")
        if operation == "export_state":
            if "state" not in reply:
                raise RuntimeError("Invalid worker state reply.")
            state_json(reply["state"])
            return {"state": reply["state"]}
        return True
    finally:
        with state_lock:
            state_waiters.pop(key, None)


def drain(stream, source=None):
    global held_boundary
    try:
        for line in stream:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("type")
            if kind == "checkpoint.ready":
                with worker_lock:
                    boundary = event.get("boundary_id")
                    if source is worker and source is not None and isinstance(boundary, str) and re.fullmatch(r"[0-9]{1,20}", boundary):
                        if held_boundary is None:
                            token = uuid.uuid4().hex
                            held_boundary = (source, token, boundary)
                            emit({"checkpoint": {"boundary_id": token}})
                continue
            if isinstance(kind, str) and (kind.startswith("state.") or kind.startswith("checkpoint.")):
                # Filter BEFORE ordinary event handling, even without a waiter or
                # worker identity. Late, unsolicited and stale state never leaks.
                with worker_lock, state_lock:
                    key = event.get("request_id")
                    pending = state_waiters.get(key) if isinstance(key, str) else None
                    if source is not None and source is worker and pending and pending[0] is source:
                        _, operation, replies = pending
                        expected = {"export_state": "state.exported", "import_state": "state.imported",
                                    "checkpoint.release": "checkpoint.released"}[operation]
                        if kind == expected or (kind == "state.error" and event.get("operation") == operation):
                            with contextlib.suppress(queue.Full):
                                replies.put_nowait(event)
                continue
            with event_lock:
                if source is None or source is worker:
                    events.append(event)
    finally:
        with worker_lock:
            fail_state_waiters(source)


def checkpoint_rpc(req):
    """Capture while held; release is separate so the API can persist before resuming."""
    global held_boundary
    if not capture_lock.acquire(blocking=False):
        raise RuntimeError("A checkpoint operation is already pending.")
    try:
        with worker_lock:
            held = held_boundary
            if not held or held[0] is not worker or held[1] != req.get("boundary_id") or worker.poll() is not None:
                raise RuntimeError("The checkpoint boundary is no longer available.")
        if req["method"] == "checkpoint.release":
            # Retire before writing: the runner can reach its next boundary as
            # soon as release is read, even before this RPC's acknowledgement.
            with worker_lock:
                held_boundary = None
            return state_rpc({"method": "checkpoint.release", "boundary_id": held[2]}, expected_worker=held[0])
        state = state_rpc({"method": "export_state", "run_id": req.get("run_id"),
                           "owner_id": req.get("owner_id"), "boundary_id": held[2]}, expected_worker=held[0])
        state_digest = hashlib.sha256(json.dumps(state, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        tree = checkpoint_tree(req, state_digest)
        with worker_lock:
            if held_boundary != held or worker is not held[0] or worker.poll() is not None:
                raise RuntimeError("The checkpoint boundary is no longer available.")
        return {**tree, **state, "boundary_id": held[1]}
    finally:
        capture_lock.release()


def worker_env(req):
    """The built-in runner reaches models only through the loopback relay; no model credentials exist here."""
    if not relay_token:
        raise RuntimeError("The model relay is not ready.")
    return {**os.environ, "GOND_AGENT_RELAY_TOKEN": relay_token, "GOND_AGENT_API_URL": "http://127.0.0.1:8787", "GOND_AGENT_MODEL": req["model"], "GOND_AGENT_EFFORT": req.get("effort", "high"), "GOND_AGENT_HOME": "/tmp/gond-agent", "GOND_AGENT_INITIAL_PLAN": json.dumps(req.get("plan", [])),
            "GOND_AGENT_QUESTION_WAIT_MINUTES": str(req.get("question_wait_minutes", 240)),
            "GOND_AGENT_INTERACTIVE": "true" if req.get("interactive") is True else "false",
            "GOND_AGENT_PLAN_REMINDER_EVERY": str(req.get("plan_reminder_every", 6)), "GOND_AGENT_PLAN_NUDGE_LIMIT": str(req.get("plan_nudge_limit", 2))}


def dispatch(req):
    global worker, relay_token
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
    if method == "start":
        with worker_lock:
            if worker and worker.poll() is None:
                raise RuntimeError("The worker is already running.")
            relay_token = secrets.token_urlsafe(32)
            try:
                pathlib.Path(os.environ["TMPDIR"]).mkdir(parents=True, exist_ok=True)
                with open("/tmp/worker.log", "ab") as log:
                    replacement = subprocess.Popen(["/usr/local/bin/gond-agent-worker"], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                        stderr=log, text=True, bufsize=1, start_new_session=True, env=worker_env(req))
            except Exception:
                # No worker owns this credential if startup fails. Keep the relay closed.
                relay_token = None
                raise
            fail_state_waiters(worker)
            worker = replacement
            threading.Thread(target=drain, args=(worker.stdout, worker), daemon=True).start()
        return True
    if method in ("export_state", "import_state"):
        return state_rpc(req)
    if method in ("checkpoint", "checkpoint.release"):
        return checkpoint_rpc(req)
    if method == "send":
        value = req["input"]
        kind = value.get("type") if isinstance(value, dict) else None
        if not isinstance(kind, str) or kind in ("export_state", "import_state") or kind.startswith(("state.", "checkpoint.")):
            raise RuntimeError("Invalid worker input; state controls require a dedicated request.")
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
    if method == "workspace_state":
        return workspace_state()
    if method == "checkpoint_tree":
        with worker_lock:
            if worker and worker.poll() is None:
                raise RuntimeError("Running workers require a held checkpoint capture.")
            return checkpoint_tree(req)
    if method == "restore_checkpoint":
        return restore_checkpoint(req)
    if method == "snapshot":
        if not capture_lock.acquire(blocking=False):
            raise RuntimeError("A checkpoint operation is already pending.")
        try:
            with worker_lock:
                if held_boundary:
                    raise RuntimeError("The worker is held for a checkpoint.")
            command(["git", "-c", "core.hooksPath=/dev/null", "add", "--all"])
            if subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode:
                identity = req.get("identity", {})
                if any(not isinstance(identity.get(key), str) or not identity[key].strip() or any(c in identity[key] for c in "\r\n\0<>") for key in ("name", "email")):
                    raise RuntimeError("A connected GitHub commit identity is required.")
                env = dict(os.environ)
                env.update({f"GIT_{role}_{key}": identity[field] for role in ("AUTHOR", "COMMITTER") for key, field in (("NAME", "name"), ("EMAIL", "email"))})
                command(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", req.get("title", "Changes")], env=env)
            command(["git", "bundle", "create", "/tmp/work.bundle", "HEAD"])
            return {"bundle": base64.b64encode(pathlib.Path("/tmp/work.bundle").read_bytes()).decode(), "head": command(["git", "rev-parse", "HEAD"]).decode().strip()}
        finally:
            capture_lock.release()
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
    def parse_request(self):
        if not super().parse_request():
            return False
        # Check every method/path before routing, including unsupported endpoints.
        authorization = self.headers.get_all("Authorization", [])
        if not relay_token or len(authorization) != 1 or not hmac.compare_digest(
                authorization[0].encode("utf-8"), ("Bearer " + relay_token).encode("utf-8")):
            self.send_error(401, "Unauthorized")
            return False
        if self.headers.get_all("Origin") is not None or self.headers.get_all("Host", []) not in (
                ["127.0.0.1:8787"], ["localhost:8787"]):
            self.send_error(403)
            return False
        if self.command == "POST":
            content_types = self.headers.get_all("Content-Type", [])
            if len(content_types) != 1 or content_types[0].split(";", 1)[0].strip().lower() != "application/json":
                self.send_error(415)
                return False
        if self.command not in ("GET", "POST"):
            self.send_error(403)
            return False
        return True

    def relay(self):
        if (self.command, self.path) not in [("GET", "/v1/models"), ("POST", "/v1/responses"), ("POST", "/v1/search")]:
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
            deadline = time.monotonic() + 600
            while True:
                try:
                    frame = replies.get(timeout=0.2)
                except queue.Empty:
                    if time.monotonic() >= deadline:
                        break
                    readable, _, _ = select.select([self.connection], [], [], 0)
                    if readable and not self.connection.recv(1, socket.MSG_PEEK):
                        break
                    continue
                deadline = time.monotonic() + 600
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
    with worker_lock:
        fail_state_waiters(worker)
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
