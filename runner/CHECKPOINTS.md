# Runner checkpoints and restart recovery

Internal JSONL controls on the existing `AgentInput` / `AgentEvent` transport.
These are **not** model tools, user messages, or transcript events. The controller
forwards these over dedicated RPCs and isolates replies from transcript events.
RunService pairs held runner history with a private Git tree bundle, stores it
through the sealed checkpoint store, and coordinates recovery and cleanup.

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

## Opt-in quiescent capture

After start/import, before sending work, send `export_state` with
`"quiescent":true`. A successful export opts the worker into held main boundaries;
without it, existing export behavior is unchanged. `"quiescent":false` disables
future holds but does not release an already held boundary.

For a fresh capture **after publication**, send `export_state` with
`"quiescent":true,"hold":true` after the main `turn.end`. This closed-schema
boolean requires quiescent true and forbids boundary_id. Only the idle main loop
can accept it; an active/held worker returns `runner_not_idle`. A successful
request establishes a new hold, emits `checkpoint.ready`, then acknowledges
`state.exported`. Queued user/compact work cannot start until release. Capture
and persist through the normal ready handshake, not the initial exported state
alone. This captures the published HEAD rather than the prepublication tree pin.

The runner emits `{"type":"checkpoint.ready","boundary_id":"1"}` before the
first model request of each turn (after user images are normalized), and after
each completed main model/tool round. All tool results and joined subagents are
finished and paired in local history. Final `turn.end` waits for release too.
No next model request, compaction, queued user work or tool dispatch starts while
held. Export with `"boundary_id":"1"` to require that exact held history; stale
IDs fail with `boundary_mismatch`. Live tracked background shells make this
capture fail with `background_shells_active`, rather than claim an atomic tree.
This is agent-dispatch quiescence, not an OS/filesystem snapshot of arbitrary
unmanaged processes or external side effects.

Capture the tree while still held, persist both artifacts together, then send:

```json
{"type":"checkpoint.release","request_id":"release-1","boundary_id":"1"}
{"type":"checkpoint.released","request_id":"release-1"}
```

Release is a closed-schema dedicated control, not ordinary input. Invalid/stale
releases return a correlated `state.error` with operation `checkpoint.release`.
Interrupt cancels the turn but does not release the hold: the controller must
finish/abort capture and release (or discard the worker). No hold deadline may
silently resume tools underneath an in-progress tree capture.

The controller hides **all** `state.*` and `checkpoint.*` frames from transcript
events. It replaces runner boundary IDs with worker-scoped opaque tokens and
emits `{"checkpoint":{"boundary_id":"<token>"}}` over its attached transport.
Dedicated RPC `checkpoint` accepts that token plus `run_id`, `owner_id`,
`base_sha`, `identity: {name,email}` and optional `head_sha`. It validates the hold, exports history,
then captures the tree, returning `{boundary_id,state,bundle,base_sha,head_sha,
checkpoint_sha}`. It never releases. Dedicated RPC `checkpoint.release` accepts
the controller token and releases the runner. Captures/releases reject overlap
rather than build a queue. Raw `checkpoint_tree` is only available without a
live runner; publication `snapshot` cannot overlap capture or run during a hold.
Late/stale worker controls cannot capture or release a replacement worker.

`Workspace.enableCheckpoints(options, save, onError?)` in `api/src/containers.ts`
opts in using `{owner_id,base_sha,identity,head_sha?}`. Await setup before sending work. The
save callback receives the paired RPC result and must finish persistence before
returning. Only one callback runs at a time; at most one subsequent held boundary
can wait while the previous release acknowledgement is delivered. Capture/save
failure reports through optional `onError` and releases in `finally`, preserving
the prior saved checkpoint. Failed release discards the workspace. No service
integration or automatic resume is enabled by this interface alone.

`Workspace.flushCheckpoints?(): Promise<void>` waits for in-flight capture,
persistence **and release acknowledgement**, including a subsequent boundary
already received. It rejects on save/release failure (also reported to onError
for save failures), or disconnection. The most recent failed save remains visible
until a later successful save; flushing does not start a capture.

`Workspace.captureCheckpoint?(options?: {head_sha:string}): Promise<void>` requires enableCheckpoints and
an idle worker (after turn.end). It flushes prior work, requests the explicit idle
hold above, then waits for the ready consumer's single save and release. It
rejects overlapping explicit captures and propagates capture/save/release errors.
The ready consumer waits for the hold-request acknowledgement before issuing its
paired state/tree RPC, avoiding concurrent controller state operations. Callers
must not send new work concurrently.

The optional `head_sha` is a restore baseline, not an assertion about the worker's
current HEAD. Without it, the foundation retains its original behavior: capture
uses actual HEAD as the private checkpoint commit's parent, metadata pin and bundle
exclusion. Production must supply the known HEAD from the authenticated checkout
when enabling capture. A worker may make unpublished local commits; using those
as restore prerequisites would require fetching SHAs that upstream does not have.
With an explicit pin, the controller validates that it names an existing commit
object and uses it for the private parent, metadata and bundle exclusion instead.
The captured tree still includes local-committed and dirty work, starting from the
actual clone HEAD. Newly staged ignored-file validation also uses actual HEAD's
tracked baseline, not the restore pin. Neither capture nor restore rewrites actual
HEAD, index or refs; local commit history itself is not preserved by tree restore.
No checkpoint metadata/schema extension or upstream history rewrite is required.

Service ordering: await `flushCheckpoints?.()` **before**
publication `snapshot`; publish/push; await `captureCheckpoint?.({head_sha:publishedSHA})` **after**
publication and **before** auto-close/CI watching. Awaiting the final turn.end
alone does not imply that its release acknowledgement has reached the API. The
postpublication capture is necessary because snapshot can create a new commit,
and recovery must pin the pushed HEAD, not its prepublication parent.
The optional capture argument updates the saved handler options inside the
serialized explicit capture, after prior captures flush and before requesting the
idle export/hold. It applies to that capture and all later captures; overlapping
explicit captures are rejected before they can change the pin. Omitting the
argument preserves the existing pin (or default actual-HEAD behavior).

Pending questions/permissions are not stored. The pre-model boundary preserves
the preceding paired round (including an initial user-only turn), so restoration
can ask the model again instead of importing an unpaired question tool call.
Once a question resolves, the next checkpoint includes its paired result.

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
  that needs an immediate legacy export must interrupt and await it. Quiescent
  mode instead retains the previous pre-model replay point described above.
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
- Import/export/release command payloads reject unknown fields, while ordinary input
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

## Restored state and service integration

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

RunService exclusively claims the latest usable checkpoint, restores the paired
tree/history into a fresh worker and sends explicit continuation framing. A failed
prerequisite checkout, tree restore or history import falls back to a fresh checkout
of the last pushed branch and records `run.checkpoint_fallback`. The predecessor
claim is consumed only when a replacement pair is durable. Answer replay remains
in a durable service ledger until that same publication transaction acknowledges
its captured history; a second restart before replacement rebuilds, rather than
stacks, synthetic continuation inputs. Pending live request IDs are never reused.

At startup, eligible interactive runs resume through the ordinary queue one at a
time, at most twice while their checkpoint is under 24 hours old. Scheduled,
stopped and quota-exhausted runs do not auto-resume. Other recoverable runs stay
`interrupted` for a human Resume/follow-up. Explicit close/Stop/deletion removes
checkpoint files; shutdown and automatic CI workspace release preserve them.
See the root README for configuration, retention and operational limits.

The controller bounds both state pipe writes and reply waits with one 120-second
deadline. Failed writes discard the worker/process group and its relay credential:
a partial JSONL frame must never be followed by new work. Reply timeout alone
leaves the worker alive and late replies are dropped; the Workspace boundary
callback attempts release, discarding the worker if release fails. Tree restore deliberately
does not restore staging metadata; export rejects newly staged ignored files to
avoid silently losing them during capture or later publication.
