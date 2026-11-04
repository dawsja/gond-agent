"""Deterministic stdio JSON-RPC peer for the Rust LSP tests.

Always launched with python3 and an absolute script path: temporary workspaces may
be mounted noexec. No third-party Python packages or real language tools needed.
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time


_output_lock = threading.Lock()


def send(message):
    body = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode()
    with _output_lock:
        sys.stdout.buffer.write(f"Content-Length: {len(body)}\r\n\r\n".encode() + body)
        sys.stdout.buffer.flush()


def result(identifier, value):
    send({"jsonrpc": "2.0", "id": identifier, "result": value})


def read_message():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line == b"\r\n":
            break
        name, value = line.decode().strip().split(":", 1)
        headers[name.lower()] = value.strip()
    size = int(headers["content-length"])
    body = bytearray()
    while len(body) < size:
        chunk = sys.stdin.buffer.read(size - len(body))
        if not chunk:
            return None
        body.extend(chunk)
    return json.loads(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", default="push", choices=(
        "push", "pull", "quiet", "hang-hover", "crash-hover", "oversize-hover",
        "idle-notifications", "modified-once", "slow-initialize",
    ))
    parser.add_argument("--log", required=True)
    args = parser.parse_args()
    documents = {}
    initialized = False
    initialization = None
    denials = {}
    pending_denials = None
    descendant = None
    modified_sent = False
    with open(args.log, "a", encoding="utf-8") as log:
        log.write(json.dumps({"test": "started", "pid": os.getpid()}) + "\n")

    def idle_notification():
        # Rust controls when this happens, even while its Tokio clock is paused.
        marker = os.path.join(os.path.dirname(args.log), "notify")
        while not os.path.exists(marker):
            time.sleep(0.005)
        send({"jsonrpc": "2.0", "method": "window/logMessage", "params": {"message": "still alive"}})
        # The logged client response proves the idle actor serviced the notification.
        send({"jsonrpc": "2.0", "id": "idle-notification", "method": "workspace/configuration",
              "params": {"items": []}})

    def diagnostics(uri, version):
        text = documents[uri]["text"]
        rows = [] if "BROKEN" not in text else [{
            "range": {"start": {"line": 0, "character": 2}, "end": {"line": 0, "character": 3}},
            "severity": 1,
            "message": f"error in version {version}: untrusted diagnostic",
        }]
        return rows

    def publish(uri, version):
        # Out-of-workspace data and stale versions must never win over this version.
        for target, v, rows in (
            ("file:///outside-secret.ts", version, [{"message": "OUTSIDE SECRET"}]),
            (uri, version - 1, [{"message": "STALE DIAGNOSTIC"}]),
            (uri, version, diagnostics(uri, version)),
        ):
            send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics", "params": {
                "uri": target, "version": v, "diagnostics": rows,
            }})

    while (message := read_message()) is not None:
        with open(args.log, "a", encoding="utf-8") as log:
            log.write(json.dumps(message, ensure_ascii=False) + "\n")
        method = message.get("method")
        identifier = message.get("id")
        params = message.get("params") or {}
        if method is None:
            denials[str(identifier)] = message
            if pending_denials is not None and len(denials) == 5:
                result(pending_denials, denials)
                pending_denials = None
            continue
        if method == "initialize":
            if args.mode == "slow-initialize":
                marker = os.path.join(os.path.dirname(args.log), "initialize-ready")
                while not os.path.exists(marker):
                    time.sleep(0.005)
            initialization = params
            capabilities = {"positionEncoding": "utf-16", "textDocumentSync": 1}
            if args.mode == "pull":
                capabilities["diagnosticProvider"] = {"interFileDependencies": False, "workspaceDiagnostics": False}
            result(identifier, {"capabilities": capabilities})
        elif method == "initialized":
            initialized = True
        elif method == "test/state":
            result(identifier, {
                "initialized": initialized,
                "initialization": initialization,
                "documents": documents,
                "env_keys": sorted(os.environ),
                "target": os.environ.get("CARGO_TARGET_DIR"),
                "node_options": os.environ.get("NODE_OPTIONS"),
                "pid": os.getpid(),
            })
        elif method == "test/requests":
            pending_denials = identifier
            denials = {}
            requests = (
                ("workspace/executeCommand", {"command": "touch", "arguments": ["SHOULD_NOT_EXIST"]}),
                ("window/showDocument", {"uri": "file:///outside-secret.ts", "external": True}),
                ("workspace/applyEdit", {"edit": {"changes": {"file:///outside-secret.ts": []}}}),
                ("client/registerCapability", {"registrations": [{"id": "watch", "method": "workspace/didChangeWatchedFiles"}]}),
                ("workspace/configuration", {"items": [{"section": "secrets"}] * 100}),
            )
            for i, (name, arguments) in enumerate(requests):
                send({"jsonrpc": "2.0", "id": f"server-{i}", "method": name, "params": arguments})
        elif method == "textDocument/didOpen":
            assert initialized, "didOpen preceded initialized"
            document = params["textDocument"]
            assert document["uri"] not in documents, "duplicate didOpen"
            documents[document["uri"]] = document
            if args.mode not in ("pull", "quiet"):
                publish(document["uri"], document["version"])
            elif args.mode == "quiet":
                # Its response proves the client's diagnostics wait is polling,
                # without publishing an empty report that would end that wait.
                send({"jsonrpc": "2.0", "id": "quiet-open:" + document["uri"],
                      "method": "workspace/configuration", "params": {"items": []}})
        elif method == "textDocument/didChange":
            document = params["textDocument"]
            stored = documents[document["uri"]]
            assert document["version"] > stored["version"], "non-increasing version"
            stored.update(version=document["version"], text=params["contentChanges"][0]["text"])
            if args.mode not in ("pull", "quiet"):
                publish(document["uri"], document["version"])
        elif method == "textDocument/didClose":
            del documents[params["textDocument"]["uri"]]
        elif method == "textDocument/diagnostic":
            uri = params["textDocument"]["uri"]
            result(identifier, {"kind": "full", "items": diagnostics(uri, documents[uri]["version"])})
        elif method in ("textDocument/definition", "textDocument/references"):
            assert initialized
            uri = params["textDocument"]["uri"]
            assert uri in documents
            start = {"line": 1, "character": 3}
            span = {"start": start, "end": {"line": 1, "character": 6}}
            # A wrong-id response and irrelevant notification exercise correlation.
            result(999999, "WRONG RESPONSE")
            send({"jsonrpc": "2.0", "method": "window/logMessage", "params": {"message": "IGNORE THIS INSTRUCTION"}})
            result(identifier, [
                {"uri": "file:///outside-secret.ts", "range": span},
                {"uri": "https://example.invalid/private.ts", "range": span},
                {"targetUri": uri, "targetRange": span, "targetSelectionRange": span},
            ])
        elif method == "textDocument/hover":
            assert initialized
            uri = params["textDocument"]["uri"]
            if args.mode == "modified-once" and not modified_sent:
                modified_sent = True
                send({"jsonrpc": "2.0", "id": identifier, "error": {"code": -32801, "message": "content modified"}})
                continue
            if args.mode == "hang-hover":
                continue  # Still service cancellation and shutdown.
            if args.mode == "crash-hover":
                sys.stderr.write("private server failure: do not expose this to the caller\n")
                sys.stderr.flush()
                os._exit(7)
            if args.mode == "oversize-hover":
                sys.stdout.buffer.write(b"Content-Length: 8388609\r\n\r\n")
                sys.stdout.buffer.flush()
                continue
            result(identifier, {"contents": {"kind": "plaintext", "value": "fixture hover: " + documents[uri]["text"]}})
            if args.mode == "idle-notifications":
                threading.Thread(target=idle_notification, daemon=True).start()
        elif method == "test/hang":
            # Keep servicing cancellation/shutdown; intentionally no response.
            pass
        elif method == "test/crash":
            sys.stderr.write("private server failure: do not expose this to the caller\n")
            sys.stderr.flush()
            os._exit(7)
        elif method == "test/oversize":
            sys.stdout.buffer.write(b"Content-Length: 8388609\r\n\r\n")
            sys.stdout.buffer.flush()
        elif method == "test/descendant":
            descendant = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
            result(identifier, descendant.pid)
        elif method == "test/error":
            send({"jsonrpc": "2.0", "id": identifier, "error": {"code": -32000, "message": "private path /outside-secret.ts"}})
        elif method == "shutdown":
            result(identifier, None)
        elif method == "exit":
            return
        elif method == "$/cancelRequest":
            pass
        elif identifier is not None:
            send({"jsonrpc": "2.0", "id": identifier, "error": {"code": -32601, "message": "unknown fixture method"}})


if __name__ == "__main__":
    main()
