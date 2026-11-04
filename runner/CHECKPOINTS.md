# Runner checkpoints — first slice

Internal JSONL controls on the existing `AgentInput` / `AgentEvent` transport.
These are **not** model tools, user messages, or transcript events. The controller
forwards these over dedicated RPCs and isolates replies from transcript events;
the API has an opaque sealed storage module. Scheduling, automatic recovery and
RunService integration are not included.

## Commands and replies

```json
{"type":"export_state","request_id":"save-1","run_id":"run-123","owner_id":"user-456"}
{"type":"state.exported","request_id":"save-1","state":{"schema_version":1,"runner_state_version":"gond-agent-checkpoint-1","run_id":"run-123","owner_id":"user-456","history":[],"plan":[],"counters":{"sub_counter":0,"main_context":0,"plan_calls":0,"plan_last":[],"plan_nudges":0,"turn_compactions":0,"skipped_history_len":null}}}
```

Send that **state object**, not its wrapper or a model request, to a fresh worker:

```json
{"type":"import_state","request_id":"load-1","run_id":"run-123","owner_id":"user-456","state":{"schema_version":1,"runner_state_version":"gond-agent-checkpoint-1","run_id":"run-123","owner_id":"user-456","history":[],"plan":[],"counters":{"sub_counter":0,"main_context":0,"plan_calls":0,"plan_last":[],"plan_nudges":0,"turn_compactions":0,"skipped_history_len":null}}}
{"type":"state.imported","request_id":"load-1"}
```

Failures use `{"type":"state.error","request_id":"…","operation":"import_state","code":"…"}`
(or operation `export_state`). Codes are `invalid_command`, `runner_not_fresh`,
`export_queue_full`, `incompatible_version`, `binding_mismatch`, `invalid_schema`,
`invalid_counters_or_plan`, `invalid_role_placement`, `invalid_tool_call`,
`unpaired_tools`, `invalid_image`, and `state_too_large`.

Request/run/owner IDs must be nonempty, at most 256 UTF-8 bytes, without control
characters. Malformed command objects with a usable request ID get a correlated
control error. Unparseable JSON or missing/oversized correlation IDs cannot be
correlated. Diagnostic logs never contain state or deserialization details.
EOF waits for accepted state controls as well as active turns.

## Boundaries and validation

- Export requests queue separately from user work, at most four pending requests.
  The main loop drains them using its **local stored history**, while idle,
  before a model round or after all calls in a main tool round have results.
  Nothing clones the transcript every round just to support checkpoints.
- No export occurs during model streaming, compaction, tool execution, or
  subagent execution. Interrupted streaming uses the runner's existing sanitized
  stored text; incomplete reasoning/tool calls are never imported into history.
- **Pending questions/permission requests cannot be snapshotted.** Export waits
  until the entire round resolves, times out, or is interrupted and has paired
  results. There is no restoration of pending questions or reply IDs. A caller
  that needs an immediate checkpoint must interrupt and await the export.
- Import is accepted only before any user/compact work or earlier import has
  been accepted, with empty initial history. The input dispatcher reserves this
  eligibility immediately: an import cannot sit behind active or queued work
  and become valid later. A reserved import failure leaves history untouched,
  but consumes eligibility; use a new worker to retry. Oversize/invalid command
  rejection before reservation does not consume eligibility.
- The canonical serialized **state object** is limited to 4 MiB, before and after
  image normalization. This is separate from the enclosing JSONL frame. There
  is no new general stdin framing limit in this slice; the trusted controller
  must bound incoming frames too. Oversized stored history fails export; export
  never silently filters images or compacts history to make it fit.
- Import/export command payloads reject unknown fields, while ordinary input
  frames remain forward-compatible with API metadata such as `user.effort`.
- Checkpoint, counters, plan items, messages, blocks, result parts and opaque
  envelopes deny unknown fields. Arbitrary tool `input` and provider opaque
  `data` remain JSON payloads by design. Roles are only user/assistant/tool;
  block placement, unique call IDs, adjacent call/result rounds, matching tool
  names, and complete results are validated. Plans (including cadence's last
  plan) are limited to 50 steps of 300 Unicode characters each.
- All stored images survive export, including images older than the newest
  eight. Only `ResponsesRequest` applies the eight-image projection. Every
  imported attachment and tool-result image passes `images.rs` raster
  normalization; bad/unresolved images reject the transaction. Normalization
  can change bytes/media type, and decoder saturation is an import error.
- Both `SCHEMA_VERSION` and the explicit `RUNNER_STATE_VERSION` compatibility
  epoch must match exactly. The epoch is independent of Cargo's package version;
  **bump it whenever history/tool/compaction/counter semantics become
  incompatible**. No old-version migration or permissive fallback is provided.
- Commands supply the expected run and owner. Import checks both against state;
  the first export or successful import binds subsequent controls on that
  worker. This is not authentication: the service must independently check
  ownership and prevent checkpoint substitution/tampering.

## Restored state and remaining integration seams

History preserves compaction's untrusted user-role summary and deterministic
file notes verbatim. The current plan, main context estimate, subagent ID counter,
plan reminder calls/last plan/nudge count, and per-turn compaction count/skip
length are saved. Imported cadence/nudge/compaction counters are consumed by the
first subsequent main turn; ordinary later user turns still reset their own
turn-local budgets. Import itself stays idle and emits no model/tool work or
ordinary transcript frames. The caller must send the intended continuation.

Runtime configuration (model/effort, prompts/instructions, permission mode/rules,
skills/tools, cadence interval/nudge limit, question timeout) comes from the new
worker, not checkpoint JSON. The service must supply the intended configuration.
Live subagent histories, shells/processes, read sets, edit baselines, pending
permissions/questions, filesystem/Git state and external side effects are not
restored. A checkpoint alone is not exactly-once execution or a filesystem
snapshot: the service must pair it with the correct checkout/bundle and define
crash/publication ordering, continuation, persistence, retention and version
upgrade behavior. State payloads may contain private repository/tool/provider
content and must not enter normal logs or browser transcripts.

The root guide, README and protocol describe this foundation and the remaining
lifecycle work. RunService must pair these primitives under a quiescent tree/history
boundary and wire recovery and cleanup before enabling persistence.

The controller bounds both state pipe writes and reply waits with one 120-second
deadline. Failed writes discard the worker/process group and its relay credential:
a partial JSONL frame must never be followed by new work. Reply timeout alone
leaves the worker alive and late replies are dropped. Tree restore deliberately
does not restore staging metadata; export rejects newly staged ignored files to
avoid silently losing them during capture or later publication.
