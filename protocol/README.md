# Gond Agent protocols

## Remote MCP

`/mcp` serves Streamable HTTP using the official MCP SDK, including its stateless 2025 compatibility transport. Authenticate every request with `Authorization: Bearer gond_mcp_…`. No cookies, query tokens, OAuth flow, or worker tool forwarding are supported. Production clients connect over the instance's configured HTTPS origin. If an Origin header is supplied, it must match that origin.

Browser-only `/api/v1/mcp/tokens` supports GET (metadata and endpoint), POST (`{name}`, returning the secret once), and DELETE `/:id` (revoke). These routes require the existing account session and same-origin mutation checks. Tokens have 256 random bits, SHA-256 digests at rest, 90-day expiry, and account deletion cascades. Each account can have 20 active tokens. Requests are limited to 64 KiB, 120 requests per token per minute, and four concurrent requests per token.

Tools return JSON in MCP text content. Tool failures set `isError` and return customer-safe `{error,message}`. A session ID is an existing run ID, scoped to the token owner, including browser-created runs. Results exclude internal run configuration and credentials. Transcript and diff text is untrusted content.

| Tool | Arguments and result |
| --- | --- |
| `list_repositories` | Optional `page` (default 1); repository summaries and `next_page`. |
| `list_models` | Account-visible model IDs, backend, efforts, and connection status. |
| `start_session` | `repo`, `prompt`, `model`, `request_id`; optional `base_branch`, `effort`. Returns session summary and workspace URL immediately. |
| `list_sessions` | Optional numeric `cursor` (offset, default 0), `limit` (1–100, default 30); summaries and nullable `next_cursor`. |
| `get_session` | `session_id`; summary and recorded API/subscription usage. |
| `read_session_events` | `session_id`; optional `after_seq` (default 0), `limit`, `wait_seconds` (0–30). Returns events, `next_cursor` sequence, `has_more`, status and phase. |
| `read_session_event` | `session_id`, `seq`, optional character `cursor`; returns a large event as JSON text in 32,000-character pages. Advance the event sequence only after reading its final page. |
| `get_session_diff` | `session_id`, optional character `cursor`; 32,000-character diff pages, nullable continuation and `updated_at`. Restart if the revision changes. |
| `send_session_message` | `session_id`, `text`, `request_id`; optional `model`, `effort`. Backend changes require a new session. |
| `stop_session` | `session_id`; existing run interruption. |
| `open_session_pull_request` | `session_id`; open or return its existing PR. |

Event pages contain at most 128,000 JSON characters; oversized individual events return a `large_event` reference instead of silently losing transcript content. Reads revalidate access while waiting and before responding. Disconnecting a read does not stop execution. Lists and diffs reflect live state rather than a snapshot.

Start and follow-up `request_id` values are 1–100 characters, token-scoped and persisted across restart. Retry with identical arguments; changed arguments conflict. Start reserves a stable run ID before asynchronous work; run insertion and initial queueing are atomic. Follow-up enqueue and result persistence are atomic. Sessions retain `source: "mcp"` and token ID attribution. No billing fallback, direct shell/file access, merges, account deletion or image input tools are added.

Retention keeps all request records for valid tokens. Scheduler cleanup removes records for invalid tokens and deletes token metadata 30 days after expiry or revocation. Schedule claims older than 30 days are removed unless they match a schedule's current occurrence.

## Model requests

Authenticated workspace run-list/detail reads refresh only their account's linked PR metadata using read-only GraphQL batches of up to 25 PRs, a 30-second cache and a five-second request limit. Missing/unavailable metadata preserves the last known state. `run.pr` can carry optional `state: open|closed|merged`; display updates the existing PR card. External merges mark idle runs merged and close their workspaces; active/queued work finishes before finalization. Follow-ups to known merged PRs are rejected. The scheduler does not perform GitHub polling.

The workspace normalizes tool names and structured arguments only for display. Stored `tool.start` events keep their original identities and inputs. Consecutive local exploration and file edits render as expandable groups; external MCP calls retain connection identity in details. Completion and failure labels follow observed tool status, without generating additional agent prose or treating completion as proof that a check passed.

Subscription models do not require API connections. Provider settings accept an empty `connections` array with an empty `defaultModel` to remove all API providers. Empty Settings remain empty after reload; first-time API setup offers an unsaved draft. Composer discovery messages are scoped to the selected API connection; subscription selections suppress API connection warnings. With no selectable model, API discovery failures remain visible.

The internal container worker calls `GET /v1/models` and `POST /v1/responses` through its loopback proxy at 127.0.0.1:8787. The service receives those requests over Docker's attached stdio channel and scopes them to that run; no network-facing model/control ports or provider keys are needed inside workers. Schemas: `api/src/wire.ts` and `runner/src/api/wire.rs`. Model responses use SSE (`event: <name>`, `data: <JSON>`): response/block starts, block deltas/ends, errors, and response.end with token usage and a stop reason. Opaque reasoning blocks retain their provider and connection-scoped model identity. Provider API URLs, formats, encrypted keys and model IDs live in SQLite; only administrators can edit them. The service translates to Anthropic Messages, OpenAI Chat Completions or OpenAI Responses and sends keys only to the configured endpoint.

## Agent events

Worker stdin accepts newline-delimited JSON: `user` with text and image references, `interrupt`, `compact`, and model/mode/skill controls. Output is newline-delimited JSON: session.start, turn.start/end, text.delta, reasoning.delta, tool.start/output/images/end, todos, agent.spawn/status/end, usage, compacted and error. Main-agent events use `agent_id: main`. The container worker runs autonomously with all tools allowed inside its workspace. Agent schemas live in `runner/src/agent/events.rs`.

`tool.images` carries `{agent_id,call_id,images:[{media_type,data}]}` from the worker, where data is base64. The service accepts at most eight raster images (5 MiB each), stores them with the run owner in the existing images table, and emits/persists only `{id,media_type}` references. The existing authenticated run-image endpoint serves the bytes; inline image data is not stored in transcript JSON. Tool results to the model keep their original image result parts.

Built-in additions: `symbols {action:"outline"|"definitions"|"references",path?,symbol?,limit?}` uses Universal Ctags for declarations and whole-identifier lexical matching for references (not semantic/LSP resolution). Searches cap files at 5000, skip files over 1 MB and honor ignores. `batch {calls:[{tool,input}]}` runs 1–8 independent built-in read calls, retaining order and per-result labels/errors; only read, list_directory, glob, grep, symbols and bash_output are allowed. `browser {url,script}` executes a Playwright test body with page/expect at wide and phone sizes; it is an execution tool, unavailable to read-only explore agents and blocked in plan mode. Chromium runs headlessly without its own sandbox; the non-root, limited container is its containment boundary, not a separate kernel.


## Container control

Before container startup, the service makes a depth-one, single-branch, tag-free checkout using command-scoped GitHub credentials. Resumed runs clone their saved run branch and shallow-fetch the pinned original base SHA for cumulative diffs; no full Git history is transferred. `run.status.step` distinguishes cloning (including rate-limited, sanitized download/checkout percentages), packing, container startup, loading the checkout, and agent startup. Compressed checkout archives are bounded to 128 MiB before base64 encoding; oversized archives fail with `repository_too_large` rather than exceeding controller frames. Clone/packing errors are plain customer messages; technical subprocess details remain in service logs.

`ContainerPool` creates a labeled per-run bridge network, workspace volume and non-root container from the operator-selected worker image (default `ghcr.io/dawsja/gond-agent-worker:main`). Compose pulls this image alongside the runtime; its one-shot image helper exits without starting the controller. Limits default to 2 CPUs, 2 GiB RAM, 512 processes and 256 MiB shared memory. The root is read-only; home and /tmp are writable tmpfs mounts. All capabilities are dropped, privilege escalation is disabled, Docker's default seccomp policy remains enabled, and no host paths, credentials, devices, Docker socket or published ports are supplied. Containers share the Docker host kernel; network separation does not deny host/LAN egress. Operators should use a dedicated host and suitable egress policy.

The service attaches stdin/stdout with `docker start --attach --interactive`, with no TTY. Newline-delimited JSON requests `{id,method,...args}` receive `{id,result}` or `{id,error}`. Methods: ping; setup (base64 repository tar archive, extracted with Python's data filter); start (model); send (AgentInput); events (zero-based after cursor, at most 200 events and approximately 16 MiB per batch, allowing one larger image event); snapshot (requires `{identity:{name,email},title?}` resolved by the service; commit as that author and committer with hooks/signing disabled and return base64 git bundle and HEAD); diff. A frame is limited to 256 MiB. Worker stderr stays in /tmp/worker.log; control errors go to service logs, not ordinary customer messages.

Model traffic shares that channel: the controller emits `{model:{id,method,path,body}}` (body is base64), and the service replies with `{model_id,status,headers}`, zero or more `{model_id,chunk}` frames (base64 bytes), and `{model_id,end:true}`. HTTP/SSE chunks are forwarded incrementally with backpressure. `{model_cancel:id}` aborts a disconnected request. Only GET /v1/models and POST /v1/responses are accepted. The run scope is bound by the service closure, not by credentials supplied to the worker.

On stdin EOF or termination, the controller stops its worker. Cleanup removes containers before their volumes/networks and is idempotent. Recovery sweeps only resources bearing this installation's `io.gond-agent.managed`, `io.gond-agent.instance` and optional `io.gond-agent.run` labels. The random instance identity persists in /data/container-instance; do not run multiple services against the same data directory.

## Workspace API

Authenticated `GET /api/v1/me` includes `user.image` and `user.has_photo`, with `automations:{auto_pr}` only. `PUT /api/v1/me/automations {auto_pr:boolean}` rejects retired polling preferences. The scheduler only executes saved schedules and retention cleanup; it does not poll GitHub issues, checks or pull requests. Existing historical events remain stored, but no issue/check-triggered messages are generated.

Authenticated `GET /api/v1/me/deletion` returns `{last_account,has_password,blocked_reason}` without caching. Same-origin `DELETE /api/v1/me {confirmation:<exact account email>,password?:string}` deletes only the signed-in account after the Settings confirmation modal. Password accounts require Better Auth password verification; passwordless accounts require a session created within 15 minutes. Attempts are bounded to five per account per 15 minutes. Active runs and deletion of the last administrator while other users remain return 409. Account changes are serialized with authentication callbacks/registration; pending run creations cannot recreate deleted account data. Idle containers and scoped checkout caches are closed/removed first. Better Auth removes the user, credentials and sessions; a SQLite trigger atomically removes owned records, including retained/deleted runs and scheduled occurrence claims. Final-account deletion also clears provider/GitHub/OIDC connections and resets in-memory auth, model discovery and device-login state. The response is `{ok:true,setup_reset:boolean}` with expired auth cookies and `Cache-Control:no-store`. Native `/api/auth/delete-user` remains disabled so it cannot bypass the workspace safeguards. The browser reloads `/agents/`; an empty instance reopens administrator registration, then provider setup.

`PUT /api/v1/me/photo` accepts up to 2 MiB of PNG/JPEG/WebP bytes for the current account. Bounded decoding rejects images above 16 megapixels and SVGs; the server strips metadata, resizes/circular-masks the result to a 256px PNG, and stores it in `profile_photos` with a fresh revision. The response is `{image,has_photo}`. `DELETE /api/v1/me/photo` removes only the current account's upload. Authenticated `GET /api/v1/users/:id/photo?v=<revision>` serves matching images with `image/png` and `Cache-Control: private, no-store`; stale revisions and absent photos return 404. Account deletion cascades to uploaded photos. The browser uses a round crop preview, supports repositioning/zoom, and submits the cropped PNG. Enter sends new tasks/follow-ups; Shift+Enter inserts a newline and IME/key repeats never submit.

Authenticated `GET /api/v1/github` returns `{configured,login,managed}` without credentials. Administrator-only `POST /api/v1/github/login` starts gh's device authorization in a private temporary config; repeat starts in the same session return the active flow, while other sessions receive a conflict. `GET /api/v1/github/login` returns `{status,id?,code?,url?,expiresAt?,message?}` with `Cache-Control: no-store`; another administrator session sees only `busy`/`idle`, never the code. Status values are `idle`, `starting`, `pending`, `connected`, `expired`, `cancelled`, `error`, and `busy`. The approval URL is fixed to `https://github.com/login/device`. `DELETE /api/v1/github/login {id}` cancels only the initiating session's matching flow. Codes expire after ten minutes; output is bounded and authorization subprocesses are killed on cancellation, expiry and shutdown. Approval is committed only while the initiating session remains valid and an administrator. Tokens are encrypted in SQLite, never returned to browsers/workers, and used only in scoped service command environments. Browser-managed credentials take precedence over explicitly supplied service gh credentials. Default Compose has no host GitHub-config mount.

The server root redirects to `/agents/`; only the workspace frontend is packaged and served. Public `GET /api/auth/bootstrap` returns `{firstAccount,signupAllowed,providers}` with `Cache-Control: no-store`. An empty instance shows first-administrator registration, then authenticated provider setup; existing instances show sign-in or their workspace. This public hint does not authorize registration: the serialized signup handler and database hooks enforce first-account-only registration when signup is closed.

The browser authenticates with Better Auth same-origin cookies. Email/password flows and OIDC callbacks use `/api/auth/*`. Instance configuration and run actions use `/api/v1/*`; state-changing actions require the configured Origin. OIDC settings are administrator-only and omit secrets from reads. Provider connection IDs are non-secret random UI identifiers generated with `crypto.getRandomValues`, which is available during private HTTP bootstrap.

Saving provider settings requires named connections with API formats, URLs and optional keys, not a selected model. The UI groups `openai` and `openai-responses` under an OpenAI button, with the protocol choice in Advanced settings; the Anthropic button selects `anthropic`. Names default to the provider label and may be overridden in Advanced settings. URLs are prefilled and editable through Edit URL. Saved formats remain unchanged unless explicitly edited. Clear key stages `clearKey:true` with an empty `apiKey`; Undo cancels that flag, and entering a replacement cancels pending removal. The existing PUT remains the commit point. Connections default to automatic discovery; `models` are optional manual capability/ID overrides and `discover:false` disables listing for that connection. Provider settings contain `connections` and an optional instance `defaultModel`; Auto falls back to the first available model.

Authenticated `GET /api/v1/models` powers agent and scheduled-run model pickers. It discovers `/models` on every configured connection concurrently, rejects redirects, and bounds Anthropic pagination to five pages and 500 unique models. Responses contain `{models,connections:[{id,name,status,message?}]}`; each model includes its connection ID/name and an encoded connection-scoped model ID. Supported status values are `ready`, `empty`, `unsupported` and `error`. One failed connection does not hide healthy connections or manual overrides. Catalogs and in-flight requests are shared per instance/database for 60 seconds and invalidated by URL, format, key or discovery-mode changes. `?refresh=1` refreshes with a five-second minimum interval. Cached metadata may remain usable during a temporary listing failure, but never after the corresponding connection's credentials change. Keys, provider URLs and upstream error bodies are not returned in the catalog. Run creation, scheduling and the model relay resolve the chosen connection-scoped ID, including on a cold service restart.

A run starts with `POST /api/v1/runs {repo,base_branch?,model,prompt,images?}`. Messages, stop, pull creation, merge and deletion are scoped to the authenticated owner. Upload images first to `/api/v1/images`. Run status: queued, working, ready, failed, stopped, merged. A one-use ticket from `POST /api/v1/runs/:id/ticket` opens `/ws/runs/:id?ticket=...&after=<seq>`. Replay resumes after a persisted sequence number. Events carry seq and ts; run.info describes live status without becoming a transcript row. A ping gets a pong. Tickets expire after one minute and are consumed on use.

## Native subscription backends and effort

Catalog model entries include optional `resolved_model`: the exact upstream ID reported by the API or native CLI. Claude Code's `ModelInfo.resolvedModel` is retained in account catalogs and used to render versioned names. Native selection IDs remain aliases so existing runs and schedules keep their routing behavior. Claude IDs are formatted generically without a version map; provider-advertised full names and custom labels are preserved. Missing resolution metadata never supplies an invented version. Pickers expose and search the exact reported identifier.

Runs and schedules accept optional `effort` (`default`, or a model-advertised effort). Runs persist their resolved connection-scoped model ID and effort. `GET /api/v1/models` also includes account-owned subscription model IDs (`cli-codex:<encoded model>` or `cli-claude-code:<encoded model>`), `backend`, and `efforts`. API model IDs keep their existing connection scope. Subscription catalogs are never shared across accounts. Explicit unsupported effort choices return 400. Unknown API models use provider defaults unless an administrator configures capability overrides. Worker startup accepts `GOND_AGENT_EFFORT`; JSONL `effort` controls apply to subsequent requests. Model and effort controls precede each user message. Follow-up bodies accept `model` and `effort`; changing backend requires a new run.

The workspace uses the same model and effort popovers for tasks, follow-ups and schedules. Message composer controls are ordered attachment, model, effort; selecting a different model resets effort to its default. Brand detection recognizes connection-scoped API IDs and native subscription aliases independently of transport format.

`GET /api/v1/cli/runtimes` reports managed installation state and supported release versions. Administrator-only `POST` and `DELETE /api/v1/cli/runtimes/:backend` install/update and uninstall immutable runtime volumes. CLI installation does not configure an API connection. Personal `GET /api/v1/cli/accounts` reports connection status, session-owned pending authorization details, and latest vendor allowance observations. `POST /api/v1/cli/accounts/:backend/login` starts authorization; `POST .../:backend/code {code}` submits Claude's returned authorization code. `DELETE .../:backend/login` cancels the initiating session's flow; `DELETE .../:backend` removes the account's connection. These routes use the existing authentication and origin protections and return no stored credentials.

The container controller supports `cli_prepare` (private credential/session state and backend configuration), `cli_state` (bounded private state), and `cli_stop`. Credentials are encrypted at rest and are never emitted as transcript events. Native runs pin their runtime volume and vendor version. Only the selected account's managed subscription credentials enter a native CLI worker; API keys, host auth directories, and the Docker socket remain excluded. Native events are translated into the existing text/tool/turn protocol, with `cli.usage` and `cli.limits` carrying vendor usage observations. A worker-local MCP tool server exposes optional Gond tools. Completion is not gated on tool usage or verification fingerprints.

`POST /api/v1/cli/accounts/:backend/close` closes the account’s idle workspaces without deleting run history. Administrators can close all idle workspaces of a runtime with `POST /api/v1/cli/runtimes/:backend/close`. Both refuse while matching runs are active; neither interrupts other users’ work.


## Driving Gond Agent from another bot

Send JSON-RPC MCP `tools/call` requests to `/mcp` using an account-owned bearer token (not cookies). Existing `status` and `phase` fields are unchanged. `get_session`, each entry in `list_sessions`, and `read_session_events` share these additive fields:

| state | Existing status | done | waiting_for_input / asking_question |
| --- | --- | --- | --- |
| queued | queued, or pending follow-up | false | false |
| working | working (including boot/publish) | false | false |
| waiting_for_input | active with an emitted pending question | false | true |
| done | ready, no queued work | true | false |
| failed | failed, no queued work | true | false |
| stopped | stopped, no queued work | true | false |
| merged | merged, no queued work | true | false |

`done` means the current work has ended (successfully or otherwise), not that follow-ups are forbidden. `question` is the pending question text or null; `last_error` is the failed run's last error message or null; `pr_url` is a URL or null. Finishing/pushing is still working, not done. Headless API workers do not emit questions: `ask_user` tells them to proceed autonomously. A final response merely phrased as a question is not an input-blocking event. If a worker emits a real pending question, send its answer with `send_session_message`; API-worker answers are routed to that request instead of queued behind the blocked turn.

`read_session_events` accepts `wait_seconds:0..30`. It returns on new events, terminal work, pending input, or the wait deadline, checking persisted state at most every 250 ms even without new events. Result `return_reason` is `done`, `waiting_for_input`, `events`, or `timeout` (in that priority). Read `has_more` and advance `after_seq` to `next_cursor`; large events use `read_session_event`. Completion can be returned alongside unread events: drain remaining pages if the full transcript is needed. Token validity and account ownership are rechecked before returning waited-for data. Disconnecting the client does not stop work.

Typical sequence (responses below show the JSON inside MCP text content, with unrelated fields omitted):

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_models","arguments":{}}}
```
```json
{"models":[{"id":"local:coder","name":"Coder","backend":"api","efforts":["default"]}],"connections":[]}
```
Append your own requirements to `prompt`. Reuse `request_id` only for identical retries; changed work needs a new ID.
```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"start_session","arguments":{"request_id":"ticket-123-v1","repo":"owner/repo","model":"local:coder","prompt":"Implement ticket 123. Follow our review and testing rules appended here."}}}
```
```json
{"id":"run_abc","status":"queued","state":"queued","done":false,"waiting_for_input":false,"asking_question":false,"question":null,"pr_url":null,"last_error":null}
```
Repeat the event read with the returned cursor until `done` or `waiting_for_input`, rather than assuming an empty page means finished:
```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_session_events","arguments":{"session_id":"run_abc","after_seq":0,"wait_seconds":30}}}
```
```json
{"events":[],"next_cursor":0,"has_more":false,"status":"ready","phase":"agent","state":"done","done":true,"waiting_for_input":false,"asking_question":false,"question":null,"pr_url":null,"last_error":null,"return_reason":"done"}
```
```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_session","arguments":{"session_id":"run_abc"}}}
```
Use `list_sessions` for the same status contract across your browser and MCP sessions. Inspect the cumulative diff in character-cursor pages; restart at zero if `updated_at` changes:
```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_session_diff","arguments":{"session_id":"run_abc","cursor":0}}}
```
```json
{"diff":"diff --git a/file b/file\n...","next_cursor":null,"updated_at":1234567890}
```
```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"send_session_message","arguments":{"session_id":"run_abc","request_id":"ticket-123-v2","text":"Also cover the empty case."}}}
```
```json
{"accepted":true,"session_id":"run_abc"}
```
Wait for completion again, then publish when desired (automatic PR creation may already have supplied `pr_url`):
```json
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"open_session_pull_request","arguments":{"session_id":"run_abc"}}}
```
```json
{"url":"https://github.com/owner/repo/pull/42","number":42}
```

Runs have no elapsed-time, idle, step, token-total or tool-call budgets. Explicit close/stop/merge/delete, failures and shutdown/recovery clean up containers; idle containers do not expire. CPU/memory/PID, archive/frame/body/output sizes, queued-message bounds, MCP traffic and concurrency limits remain resource protections. Bash foreground calls time out after 120 seconds by default (maximum 600 seconds), returning a tool error so the loop continues; long builds can run in the background and be read with `bash_output`. Model requests have no elapsed-time abort; disconnect/cancellation still aborts them. Control RPCs and Git operations retain per-operation timeouts for unavailable infrastructure. Successful turn publication commits as the connected GitHub account using one service identity resolver, never a fixed product author. Optional name/email overrides are documented in README.
