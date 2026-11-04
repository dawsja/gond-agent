// Turns a run's event stream (protocol/README.md §2–3) into what the run screen draws.
import type { RunStatus } from "../../lib/api"
import { EDIT_TOOLS, EXPLORE_TOOLS, presentTool } from "./tool-presentation"

// Event fields depend on their type; see protocol/README.md.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StreamEvent = { type: string; seq: number; ts: number; [key: string]: any }

export interface ToolCall {
  callId: string
  name: string
  label: string
  title: string
  paths: string[]
  source?: string
  status: "running" | "done" | "failed"
  summary: string
  output: string
  diff?: string
  images?: { id: string; media_type: string }[]
  start: number
  end?: number
}

export interface SubAgent {
  id: string
  kind: string
  description: string
  status: "running" | "done" | "failed"
  activity: string
  tools: number
  elapsedMs: number
  summary: string
}

export type PlanStep = { text: string; status: "pending" | "in_progress" | "done" }
export type CiState = "pending" | "passing" | "failing" | "none" | "gave_up" | "unavailable"

export type Item =
  | {
      kind: "user"
      key: string
      text: string
      ts: number
      images: { id: string; media_type: string }[]
    }
  | { kind: "text"; key: string; text: string }
  | { kind: "ci"; key: string; text: string }
  | { kind: "ci-status"; key: string; state: CiState; round: number; sha: string; failing: string[]; reason?: string }
  | { kind: "explore"; key: string; tools: ToolCall[] }
  | { kind: "edits"; key: string; tools: ToolCall[] }
  | { kind: "tool"; key: string; tool: ToolCall }
  | { kind: "plan"; key: string; steps: PlanStep[] }
  | { kind: "agents"; key: string; agents: SubAgent[] }
  | { kind: "released"; key: string }
  | { kind: "compacted"; key: string; reason?: string; before?: number; after?: number }
  | { kind: "pr"; key: string; number: number; url: string; ts: number; state?: "open" | "closed" | "merged" }
  | { kind: "end"; key: string; status: RunStatus; error?: string; ts: number }

export interface Transcript {
  items: Item[]
  status: RunStatus | null
  step: string | null
  /** Run start (first event) and runner log lines for the Logs tab. */
  startedAt: number | null
  log: { ts: number; source: string; text: string }[]
  /** Unified diffs of the agent's own edits, oldest first (before the runner's commit diff exists). */
  editDiffs: string[]
  committed: number
  /** Refresh live queue metadata even when a position update does not change status. */
  queueRevision: number
}

const OUTPUT_CAP = 8_000

export function createTranscript() {
  const items: Item[] = []
  const calls = new Map<string, ToolCall>()
  const agents = new Map<string, SubAgent>()
  const log: Transcript["log"] = []
  const editDiffs: string[] = []
  let plan: Extract<Item, { kind: "plan" }> | null = null
  let status: RunStatus | null = null
  let step: string | null = null
  let committed = 0
  let queueRevision = 0
  let startedAt: number | null = null
  let lastSeq = 0
  const owners = new WeakMap<ToolCall | SubAgent, Item>()
  const snapshots = new WeakMap<Item, Item>()
  const dirty = new Set<Item>()
  let snapshot: Transcript = { items: [], status, step, startedAt, log: [], editDiffs: [], committed, queueRevision }
  const last = () => items[items.length - 1]
  const mark = (item: Item | undefined) => { if (item) dirty.add(item) }

  // Only fold new events. Mutable working objects never escape into React snapshots.
  return (events: StreamEvent[]): Transcript => {
    for (const ev of events) {
      if (ev.seq <= lastSeq) continue
      lastSeq = ev.seq
      startedAt ??= ev.ts
      const owned = ev.type.startsWith("tool.") ? calls.get(ev.call_id) : agents.get(ev.agent_id)
      if (owned) mark(owners.get(owned))
      const main = ev.agent_id === undefined || ev.agent_id === "main"
      switch (ev.type) {
        case "user":
          items.push({
            kind: "user",
            key: `u${ev.seq}`,
            text: ev.text,
            ts: ev.ts,
            images: Array.isArray(ev.images) ? ev.images : [],
          })
          break
        case "ci":
          items.push({ kind: "ci", key: `ci${ev.seq}`, text: ev.text })
          break
        case "run.ci": {
          const fields = { state: ev.state, round: ev.round, sha: ev.sha, failing: Array.isArray(ev.failing) ? [...ev.failing] : [], reason: ev.reason }
          const l = last()
          if (l?.kind === "ci-status" && l.sha === ev.sha && l.round === ev.round) { mark(l); Object.assign(l, fields) }
          else items.push({ kind: "ci-status", key: `cs${ev.seq}`, ...fields })
          break
        }
        case "text.delta": {
          if (!main) break
          const l = last()
          if (l?.kind === "text") { mark(l); l.text += ev.text }
          else items.push({ kind: "text", key: `t${ev.seq}`, text: ev.text })
          break
        }
        case "stream.reset": {
          if (!main) break
          let remaining = ev.text_length
          // Queued follow-ups can insert user items in the middle of this attempt.
          for (let i = items.length - 1; i >= 0 && remaining > 0; i--) {
            const item = items[i]
            if (item.kind !== "text") continue
            const removed = Math.min(remaining, item.text.length)
            remaining -= removed
            if (removed === item.text.length) items.splice(i, 1)
            else { mark(item); item.text = item.text.slice(0, -removed) }
          }
          break
        }
        case "compacted":
          if (!main) break
          items.push({
            kind: "compacted",
            key: `compact${ev.seq}`,
            reason: typeof ev.reason === "string" ? ev.reason : undefined,
            before: typeof ev.before === "number" && Number.isFinite(ev.before) && ev.before >= 0 ? ev.before : undefined,
            after: typeof ev.after === "number" && Number.isFinite(ev.after) && ev.after >= 0 ? ev.after : undefined,
          })
          break
        case "tool.start": {
          if (!main) break
          const call: ToolCall = { callId: ev.call_id, ...presentTool(ev.name, ev.title ?? "", ev.input), status: "running", summary: "", output: "", start: ev.ts }
          calls.set(ev.call_id, call)
          if (["update_plan", "task", "Agent", "Task"].includes(ev.name)) break // These backends also emit plan/agent events.
          const l = last()
          const group = EXPLORE_TOOLS.has(call.name) ? "explore" : EDIT_TOOLS.has(call.name) ? "edits" : undefined
          if (group) {
            if (l?.kind === group) { mark(l); l.tools.push(call) }
            else items.push({ kind: group, key: `x${ev.seq}`, tools: [call] })
          } else {
            items.push({ kind: "tool", key: `c${ev.seq}`, tool: call })
          }
          owners.set(call, last())
          log.push({ ts: ev.ts, source: "agent", text: `${call.label} ${call.title}`.trim() })
          break
        }
        case "tool.output": {
          const c = calls.get(ev.call_id)
          if (c) c.output = (c.output + ev.chunk).slice(-OUTPUT_CAP)
          break
        }
        case "tool.images": {
          const c = calls.get(ev.call_id)
          if (c) c.images = Array.isArray(ev.images) ? ev.images : []
          break
        }
        case "tool.end": {
          const c = calls.get(ev.call_id)
          if (c) {
            c.status = ev.ok ? "done" : "failed"
            c.summary = ev.summary ?? ""
            if (ev.output) c.output = String(ev.output).slice(-OUTPUT_CAP)
            c.diff = ev.diff
            c.end = ev.ts
          }
          if (ev.diff) editDiffs.push(ev.diff)
          break
        }
        case "todos":
          if (!main) break
          if (plan) { mark(plan); plan.steps = ev.items }
          else {
            plan = { kind: "plan", key: `p${ev.seq}`, steps: ev.items }
            items.push(plan)
          }
          break
        case "agent.spawn": {
          const a: SubAgent = { id: ev.agent_id, kind: ev.kind, description: ev.description, status: "running", activity: "", tools: 0, elapsedMs: 0, summary: "" }
          agents.set(ev.agent_id, a)
          const l = last()
          if (l?.kind === "agents") { mark(l); l.agents.push(a) }
          else items.push({ kind: "agents", key: `a${ev.seq}`, agents: [a] })
          owners.set(a, last())
          log.push({ ts: ev.ts, source: "agent", text: `spawned ${ev.kind}: ${ev.description}` })
          break
        }
        case "agent.status": {
          const a = agents.get(ev.agent_id)
          if (a) Object.assign(a, { activity: ev.activity, tools: ev.tool_count, elapsedMs: ev.elapsed_ms })
          break
        }
        case "agent.end": {
          const a = agents.get(ev.agent_id)
          if (a) Object.assign(a, { status: ev.ok ? "done" : "failed", summary: ev.summary })
          break
        }
        case "run.released":
          if (ev.reason === "idle_for_waiting_work") items.push({ kind: "released", key: `released${ev.seq}` })
          queueRevision++
          break
        case "run.queued":
        case "run.dequeued":
          queueRevision++
          break
        case "run.status":
          status = ev.status
          step = ev.step ?? null
          if (ev.step) log.push({ ts: ev.ts, source: "runner", text: ev.step })
          if (ev.status === "failed" || ev.status === "stopped" || ev.status === "merged") {
            items.push({ kind: "end", key: `e${ev.seq}`, status: ev.status, error: ev.error, ts: ev.ts })
            log.push({ ts: ev.ts, source: "runner", text: ev.status === "failed" ? `failed: ${ev.error ?? ""}` : ev.status })
          } else if (ev.status === "ready") {
            log.push({ ts: ev.ts, source: "runner", text: "ready" })
          }
          break
        case "run.diff":
          committed++
          log.push({ ts: ev.ts, source: "git", text: `committed · ${ev.files} files +${ev.additions} −${ev.deletions}` })
          break
        case "run.pr": {
          const existing = items.findLast(item => item.kind === "pr" && item.number === ev.number)
          if (existing?.kind === "pr") { mark(existing); existing.state = ev.state ?? "open" }
          else items.push({ kind: "pr", key: `r${ev.seq}`, number: ev.number, url: ev.url, ts: ev.ts, state: ev.state ?? "open" })
          log.push({ ts: ev.ts, source: "github", text: `${ev.state === "merged" ? "merged" : ev.state === "closed" ? "closed" : "opened"} pull request #${ev.number}` })
          break
        }
        case "session.start":
          log.push({ ts: ev.ts, source: "agent", text: `started · ${ev.model}` })
          break
      }
    }
    snapshot = {
      items: items.map(item => {
        let copy = snapshots.get(item)
        if (!copy || dirty.has(item)) {
          switch (item.kind) {
            case "tool": copy = {...item, tool: {...item.tool}}; break
            case "explore":
            case "edits": copy = {...item, tools: item.tools.map(tool => ({...tool}))}; break
            case "agents": copy = {...item, agents: item.agents.map(agent => ({...agent}))}; break
            default: copy = {...item}
          }
          snapshots.set(item, copy)
        }
        return copy
      }),
      status, step, startedAt, committed, queueRevision,
      log: log.length === snapshot.log.length ? snapshot.log : log.slice(),
      editDiffs: editDiffs.length === snapshot.editDiffs.length ? snapshot.editDiffs : editDiffs.slice(),
    }
    dirty.clear()
    return snapshot
  }
}
