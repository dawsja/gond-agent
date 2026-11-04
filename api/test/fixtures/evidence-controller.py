"""Real controller/stdio/Git fixture; only the model worker and delay injection are fake.

No Docker lifecycle claim: ContainerPool attaches to this process instead of Docker.
"""
import json
import pathlib
import subprocess
import sys
import threading
import time


def fake_worker():
    state = {"runner_state_version": "gond-agent-checkpoint-3"}
    export_delay = 0
    boundary = 0

    def emit(value):
        print(json.dumps(value), flush=True)

    for line in sys.stdin:
        frame = json.loads(line)
        kind = frame["type"]
        request_id = frame.get("request_id")
        if kind == "init_evidence":
            state["evidence"] = {"key": frame["key"]}
            emit({"type": "state.evidence_initialized", "request_id": request_id})
        elif kind == "fixture.configure":
            state["evidence"].update(frame["evidence"])
            export_delay = frame.get("export_delay", 0)
        elif kind == "fixture.finish":
            boundary += 1
            emit({"type": "checkpoint.ready", "boundary_id": str(boundary)})
            for record in state["evidence"].get("records", []):
                emit({"type": "evidence.recorded", "record": record})
            emit({"type": "turn.end", "agent_id": "main", "stop_reason": "end_turn"})
        elif kind == "export_state":
            if frame.get("hold"):
                boundary += 1
                emit({"type": "checkpoint.ready", "boundary_id": str(boundary)})
            if not frame.get("quiescent") and not frame.get("boundary_id"):
                time.sleep(export_delay)
            emit({"type": "state.exported", "request_id": request_id, "state": state})
        elif kind == "checkpoint.release":
            emit({"type": "checkpoint.released", "request_id": request_id})


if "--worker" in sys.argv:
    fake_worker()
    sys.exit(0)

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "containers"))
import agent  # noqa: E402

agent.ROOT = sys.argv[1]
original_dispatch = agent.dispatch
original_tree = agent.checkpoint_tree
tree_delay = 0


def delayed_tree(*args, **kwargs):
    global tree_delay
    delay, tree_delay = tree_delay, 0
    time.sleep(delay)
    return original_tree(*args, **kwargs)


def dispatch(req):
    global tree_delay
    method = req["method"]
    if method == "start":
        agent.worker = subprocess.Popen([sys.executable, __file__, "--worker"], stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, text=True, bufsize=1)
        threading.Thread(target=agent.drain, args=(agent.worker.stdout, agent.worker), daemon=True).start()
        return True
    if method == "fixture.configure":
        tree_delay = req.get("tree_delay", 0)
        return original_dispatch({"method": "send", "input": {"type": "fixture.configure", **req}})
    if method == "fixture.status":
        return {"held": agent.held_boundary is not None, "locked": agent.capture_lock.locked()}
    if method == "fixture.probe_snapshot":
        try:
            original_dispatch({"method": "snapshot"})
        except RuntimeError as error:
            return str(error)
        raise AssertionError("Snapshot was not blocked by the real controller")
    return original_dispatch(req)


agent.checkpoint_tree = delayed_tree
agent.dispatch = dispatch
try:
    for line in sys.stdin:
        threading.Thread(target=agent.handle, args=(json.loads(line),), daemon=True).start()
finally:
    if agent.worker:
        agent.worker.terminate()
        agent.worker.wait(timeout=5)
