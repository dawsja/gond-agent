# Browser runtime

`browser.cjs` remains the one-shot Playwright test: independent 1440×900 and
390×844 contexts, a supplied test body and two screenshots.

`persistent.cjs` is a separate typed JSON-lines daemon. The runner starts
`node /opt/gond-agent-browser/persistent.cjs <unique-profile-directory>` lazily,
owns its private stdio and process group, and removes the profile even after a
forced kill. Main work and subagents serialize requests to the same page. There
is no TCP control listener, evaluate method or page-supplied script execution
interface. Request names/arguments match the `browser_*` tools documented in
`protocol/README.md`; responses are `{ok,text,image?}` (JPEG base64). Maximum
request/response sizes are 64 KiB / 3 MiB; text is framed and capped at 30,000
bytes. Final screenshot limits are applied by `runner/src/images.rs`.

## Guards

- `proxy.cjs` is a local HTTP/CONNECT filtering proxy, not a control endpoint.
  It resolves each destination once, rejects any forbidden answer (including
  mixed answers), and connects to a validated literal IP, not the hostname.
  New connections and redirects receive new checks; sockets are not pooled.
  Metadata names, private/link-local/CGNAT/ULA/multicast/transition ranges and
  ports 8787/8788 are denied. Loopback apps on other ports are allowed.
  Both ports remain reserved although the control service now uses Docker stdio.
- Chromium uses the proxy even for loopback, with direct DNS, QUIC, WebRTC APIs,
  service workers, background networking and WebSocket connections disabled.
  Downloads are denied through CDP, popups closed, dialogs dismissed/logged,
  and no permissions granted. Non-HTTP(S) navigations terminate the context.
- One page, 16 frames, 1024 retained element handles, 500 log entries and 64 proxy
  sockets bound retained resources. DOM traversal and stdio queues are bounded.
  A 768 MiB descendant-RSS watchdog samples Linux `/proc` every two seconds and
  closes the session; this can overshoot and is not a cgroup ceiling. The
  worker's memory limit remains the hard ceiling. Each action times out at 30s.
- Close, EOF, signals, turn completion, cancellation and ten minutes idle stop
  Chromium/proxy and remove the disposable profile. Cleanup tracks descendant
  start times because Chromium may create separate process groups.
- The runner removes `RELAY_TOKEN_ENV` before spawning Node. Neither Node nor
  Chromium inherits that credential, and these scripts do not call the relay.

Chromium runs with `--no-sandbox`. The container, not these restrictions, is the
containment boundary against executed code. The unchanged script browser and
shell commands are not subject to this egress filter. Same-UID code can inspect
the runner environment through `/proc`; scrubbing is not protection from code
executed inside the container. Page text, names, logs and screenshots are
untrusted content; never insert them into system instructions.

## Checks (sequentially inside the worker)

Unset `GH_TOKEN`, `GITHUB_TOKEN` and inherited `GOND_AGENT_*` variables first.
Use npm, the checked-in lockfile and its integrity hashes; installation never
needs lifecycle scripts. The offline command needs a populated npm cache:

```sh
cd containers/browser
npm ci --offline --ignore-scripts
# Empty cache only: npm ci --ignore-scripts, then retry offline.
node --test proxy.test.cjs persistent.test.cjs
node --test browser.test.cjs
node --test persistent.chromium.test.cjs
```

The lightweight suite covers DNS pinning with an injected resolver, blocked
destinations, CONNECT, cursor bounds, fake-clock idle expiry, stdio and cleanup.
The Chromium suite drives a real loopback fixture, including refs, navigation,
screenshots, downloads/popups, permission denial, logs and policy termination.

After Cargo checks, from the repository root:

```sh
GOND_IMAGE_WORKER="$PWD/runner/target/debug/gond-agent-worker" python3 containers/smoke-browser.py
```

This standard-library-only smoke scripts a local model through the compiled
runner, verifies normalized screenshot dimensions/bytes and checks cancellation
cleanup against real Chromium. It requires the worker's explicit browser path
(`/opt/gond-agent-browser`), Node module path and installed Chromium. The
worker-image build runs both new suites and this smoke, retaining all existing
one-shot browser and worker smoke checks. Do not run Chromium alongside Cargo
or other memory-heavy commands in a 2 GiB worker.
