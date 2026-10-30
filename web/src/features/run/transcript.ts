// Turns a run's event stream (protocol/README.md §2–3) into what the run screen draws.
import type { RunStatus } from "@/lib/api"
import type { StreamEvent } from "@/lib/run-stream"

export interface ToolCall {
  callId: string
  name: string
  title: string
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

export type Item =
  | {
      kind: "user"
      key: string
      text: string
      ts: number
      images: { id: string; media_type: string }[]
    }
  | { kind: "text"; key: string; text: string }
  | { kind: "explore"; key: string; tools: ToolCall[] }
  | { kind: "tool"; key: string; tool: ToolCall }
  | { kind: "plan"; key: string; steps: PlanStep[] }
  | { kind: "agents"; key: string; agents: SubAgent[] }
  | { kind: "pr"; key: string; number: number; url: string; ts: number }
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
}

/** Read-only tools that collapse into one "Explored" group. */
const EXPLORE = new Set(["read", "glob", "grep", "symbols", "batch", "list_directory", "list_plan", "web_search", "web_fetch", "bash_output"])
const OUTPUT_CAP = 8_000

export function buildTranscript(events: StreamEvent[]): Transcript {
  const items: Item[] = []
  const calls = new Map<string, ToolCall>()
  const agents = new Map<string, SubAgent>()
  const log: Transcript["log"] = []
  const editDiffs: string[] = []
  let plan: Extract<Item, { kind: "plan" }> | null = null
  let status: RunStatus | null = null
  let step: string | null = null
  let committed = 0
  const last = () => items[items.length - 1]

  for (const ev of events) {
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
      case "text.delta": {
        if (!main) break
        const l = last()
        if (l?.kind === "text") l.text += ev.text
        else items.push({ kind: "text", key: `t${ev.seq}`, text: ev.text })
        break
      }
      case "tool.start": {
        if (!main) break
        const call: ToolCall = { callId: ev.call_id, name: ev.name, title: ev.title ?? "", status: "running", summary: "", output: "", start: ev.ts }
        calls.set(ev.call_id, call)
        if (ev.name === "update_plan" || ev.name === "task") break // shown as the plan card / agents block
        const l = last()
        if (EXPLORE.has(ev.name)) {
          if (l?.kind === "explore") l.tools.push(call)
          else items.push({ kind: "explore", key: `x${ev.seq}`, tools: [call] })
        } else {
          items.push({ kind: "tool", key: `c${ev.seq}`, tool: call })
        }
        log.push({ ts: ev.ts, source: "agent", text: `${ev.name} ${ev.title ?? ""}`.trim() })
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
        if (plan) plan.steps = ev.items
        else {
          plan = { kind: "plan", key: `p${ev.seq}`, steps: ev.items }
          items.push(plan)
        }
        break
      case "agent.spawn": {
        const a: SubAgent = { id: ev.agent_id, kind: ev.kind, description: ev.description, status: "running", activity: "", tools: 0, elapsedMs: 0, summary: "" }
        agents.set(ev.agent_id, a)
        const l = last()
        if (l?.kind === "agents") l.agents.push(a)
        else items.push({ kind: "agents", key: `a${ev.seq}`, agents: [a] })
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
      case "run.pr":
        items.push({ kind: "pr", key: `r${ev.seq}`, number: ev.number, url: ev.url, ts: ev.ts })
        log.push({ ts: ev.ts, source: "github", text: `opened pull request #${ev.number}` })
        break
      case "session.start":
        log.push({ ts: ev.ts, source: "agent", text: `started · ${ev.model}` })
        break
    }
  }
  return { items, status, step, startedAt: events[0]?.ts ?? null, log, editDiffs, committed }
}
