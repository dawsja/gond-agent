# Runner checkpoints — first slice

Internal JSONL controls on the existing `AgentInput` / `AgentEvent` transport.
These are **not** model tools, user messages, or transcript events. The controller
forwards these over dedicated RPCs and isolates replies from transcript events;
the API has an opaque sealed storage module. Scheduling, automatic recovery and
checkpoint lifecycle integration are not included. RunService does already use
private `init_evidence` to install a service-issued key before task execution and
state export for metadata at turn finish, never to adopt exported signing authority.
This does not enable checkpoint-backed recovery.

## Commands and replies

Before task execution, the API service generates a fresh random 32-byte key per
worker and sends private `init_evidence {request_id,run_id,owner_id,key}`. The runner
acknowledges `state.evidence_initialized {request_id}`. These are private controls,
not model inputs or transcript events; the key never enters environments or logs.

These minimal schema examples omit optional `evidence`. Real exports include the
private ledger described below; never copy its signing key into a transcript.

```json
{"type":"export_state","request_id":"save-1","run_id":"run-123","owner_id":"user-456"}
{"type":"state.exported","request_id":"save-1","state":{"schema_version":1,"runner_state_version":"gond-agent-checkpoint-3","run_id":"run-123","owner_id":"user-456","history":[],"plan":[],"counters":{"sub_counter":0,"main_context":0,"plan_calls":0,"plan_last":[],"plan_nudges":0,"turn_compactions":0,"skipped_history_len":null}}}
```

Send that **state object**, not its wrapper or a model request, to a fresh worker:

```json
{"type":"import_state","request_id":"load-1","run_id":"run-123","owner_id":"user-456","state":{"schema_version":1,"runner_state_version":"gond-agent-checkpoint-3","run_id":"run-123","owner_id":"user-456","history":[],"plan":[],"counters":{"sub_counter":0,"main_context":0,"plan_calls":0,"plan_last":[],"plan_nudges":0,"turn_compactions":0,"skipped_history_len":null}}}
{"type":"state.imported","request_id":"load-1"}
```

Failures use `{"type":"state.error","request_id":"…","operation":"import_state","code":"…"}`
(or operation `export_state` / `init_evidence`). Codes are `invalid_command`,
`runner_not_fresh`,
`export_queue_full`, `incompatible_version`, `binding_mismatch`, `invalid_schema`,
`invalid_counters_or_plan`, `invalid_role_placement`, `invalid_tool_call`,
`unpaired_tools`, `invalid_image`, `state_too_large`, `invalid_evidence_bounds`,
`invalid_evidence_key`, `invalid_evidence_record`, and `invalid_evidence_staleness`.

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
- `SCHEMA_VERSION` remains 1; the explicit `RUNNER_STATE_VERSION` compatibility
  epoch is `gond-agent-checkpoint-3`, independent of Cargo's package version.
  **Bump it whenever history/tool/compaction/counter semantics become
  incompatible**. The legacy compatibility path accepts only ledgerless epoch-1
  or epoch-2 state and upgrades the epoch; it supplies no prior execution evidence.
  **Old ledger-bearing epoch-2 state is rejected**, as is ledger-bearing epoch-1
  state and other incompatible epochs.
- Controls supply the expected run and owner; initialization binds the signing
  authority to them, and import checks both against state. Subsequent controls
  must respect the worker's binding. This is not authentication: the service must
  independently check ownership and prevent checkpoint substitution/tampering.

## Evidence state

Optional `evidence` is a strict typed ledger: private signing key, up to 40 signed
records (see [event schema](../protocol/README.md#execution-evidence-and-publication)),
frozen policy, sequence, gate/turn/resume/fix/review counters, stale IDs,
limitations/declaration flag and initial turn tree. All nested ledger/record/kind
fields reject unknown fields; validation checks bounds, UUID/sequence uniqueness,
signatures for non-stale keyed records and staleness references. The advisory gate
allows at most two continuations per turn, six per run and none at ten resumes;
actual runner counters persist in sealed state, import preserves them, and restore
increments the resume count. Separately, RunService durably reserves up to two
rounds in `gate_budget` at `next`, before each task is delivered, capped at six.
Before worker startup, gate rounds are seeded from `max(gate_rounds, gate_budget)`.
A crash may spend unused allowance but cannot replenish it.

The service-generated key belongs only in private controls, sealed checkpoint
state and API live memory, never ordinary run rows, transcript events, environments
or logs. The worker generates no signing authority; the API never adopts an
exported key or a changed finish key as authority. HMAC-SHA256 signs compact JSON
`{domain:"gond-agent:evidence:v1",run_id,record}`, recursively sorting object keys
and retaining array order. `record` includes every field except `sig`, including
run_id, seq, both tree hashes and `command_definition_changed`.
These are **evidence recorded by the worker**, not independent proof: signatures
authenticate records, while same-UID executed code can inspect process memory.
Only a separate-container rerun could provide independent proof, out of scope.
`env_clean` means an environment allow-list was applied; `env_digest` hashes its
values, not an absence of secrets in HOME/`.npmrc` or elsewhere.

Resume rekeys for the new worker with a fresh service-issued key, marks old records
historical/stale without re-signing them, and preserves sequence and budget
counters. Mismatched trees also make records stale; ledgerless imports request a
new check. Ignored paths are NOT covered by tree identity, even if executed by a check.
Evidence capture, publication snapshots and checkpoints use the same isolated Git
helper, ignoring clone-local/system configuration and excludes but respecting
worktree `.gitignore`; ignored dependencies such as `node_modules` may be absent after restore. Do not
treat hidden ignored code as trusted based on a matching tree.

## Restored state and remaining integration seams

History preserves compaction's untrusted user-role summary and deterministic
file notes verbatim. The current plan, main context estimate, subagent ID counter,
plan reminder calls/last plan/nudge count, and per-turn compaction count/skip
length are saved. Imported cadence/nudge/compaction counters are consumed by the
first subsequent main turn; ordinary later user turns still reset their own
turn-local budgets. Import itself stays idle and emits no model/tool work or
ordinary transcript frames. The caller must send the intended continuation.

Frozen evidence policy is restored with the ledger, unlike ordinary runtime
configuration below. Policy/manifest edits do not alter frozen checks; a later
run must pin a base containing those edits before discovering them anew.
Additional commands use the fixed grammar documented in the protocol: `npm test`,
`npm`/`pnpm`/`bun run <script>` from BASE's exact-cwd `package.json`, locked Cargo
and fixed pytest/unittest forms. Arbitrary executables, URLs and shell syntax are
not accepted; `allow-weaken` never bypasses grammar or BASE-script validation.
Command definitions/configuration are compared against BASE before and after a
check; `command_definition_changed=true` excludes gate and publication success and
produces a weakening warning. Unknown test counts never count as success.

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
