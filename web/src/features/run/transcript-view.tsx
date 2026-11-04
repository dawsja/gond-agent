// A run's transcript on its page: messages, tools, plans and subagents (TUI language, softened).
import { Check, CircleAlert, CirclePause, GitPullRequestArrow, LoaderCircle } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { Activity } from "@/components/workspace/activity"
import { ProfileAvatar } from "@/components/profile-avatar"
import type { Run, RunStatus } from "@/lib/api"
import { ago, duration } from "@/lib/format"
import { RUN_UI } from "@/lib/run-state"
import { useMe, useRunImage } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { DiffView, parseUnifiedDiff } from "@shared/diff"
import { DiffCounts, Dot, PrChip, StatusPill } from "../studio/parts"
import { STATUS, mono } from "../studio/theme"
import { type Item, type PlanStep, type SubAgent, type ToolCall, type Transcript } from "./transcript"
import { Prose as SharedProse } from "@shared/prose"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceLine, TraceTitle } from "@shared/ui/trace"
import { AgentLabel } from "./agent-label"
import { activityLabel, groupLabel } from "./tool-presentation"
import { SharedImage } from "./shared-image"

/* ───────────── transcript pieces (TUI language, softened) ───────────── */

const TOOL_STATUS: Record<ToolCall["status"], RunStatus> = { done: "ready", running: "working", failed: "failed" }

/** The agent's prose at a readable measure, in the Studio type scale. */
export const Prose = ({ text, small }: { text: string; small?: boolean }) => <SharedProse text={text} small={small} className={cn("max-w-[62ch]", !small && "text-[14px]")} />

function Tool({ status = "done", name, arg, children, right }: { status?: ToolCall["status"]; name: string; arg?: ReactNode; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="text-[13px] leading-[22px]" style={mono}>
      <div className="flex items-center gap-2.5">
        <Dot status={TOOL_STATUS[status]} size={7} />
        <span className="shrink-0 font-medium whitespace-nowrap text-foreground">{name}</span>
        {arg && <span className="min-w-0 truncate text-muted-foreground">{arg}</span>}
        {right && <span className="ml-auto shrink-0">{right}</span>}
      </div>
      {children && <div className="pl-[3px]">{children}</div>}
    </div>
  )
}

function Branch({ last = true, children }: { last?: boolean; children: ReactNode }) {
  return (
    <div className="flex gap-2 text-[12px] text-muted-foreground" style={mono}>
      <span className="text-subtle">{last ? "└" : "├"}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}


function PlanCard({ steps }: { steps: PlanStep[] }) {
  const done = steps.filter((s) => s.status === "done").length
  return (
    <div className="rounded-[4px] border border-border bg-surface px-4 py-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground" style={mono}>
          Plan{" "}
          <span className="text-muted-foreground">
            · {done} of {steps.length}
          </span>
        </span>
        <span className="flex gap-1">
          {steps.map((st, i) => (
            <span
              key={i}
              className="h-1 w-6 rounded-[2px]"
              style={{ background: st.status === "done" ? STATUS.ready : st.status === "in_progress" ? STATUS.working : "var(--border-strong)" }}
            />
          ))}
        </span>
      </div>
      <ul className="space-y-1.5">
        {steps.map((st, i) => (
          <li key={i} className="flex items-center gap-2.5 text-[14px]">
            {st.status === "done" ? (
              <span className="grid size-4 shrink-0 place-items-center rounded-[3px] bg-ready/15 text-ready">
                <Check className="size-3" strokeWidth={3} />
              </span>
            ) : st.status === "in_progress" ? (
              <span className="grid size-4 shrink-0 place-items-center rounded-[3px] border border-working/60">
                <span className="size-1.5 rounded-full bg-working" />
              </span>
            ) : (
              <span className="size-4 shrink-0 rounded-[3px] border border-border-strong" />
            )}
            <span
              className={cn(
                st.status === "done" && "text-muted-foreground line-through decoration-subtle",
                st.status === "in_progress" && "text-foreground",
                st.status === "pending" && "text-muted-foreground",
              )}
            >
              {st.text}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const took = (t: ToolCall) => (t.end ? duration(t.end - t.start) : undefined)

function ToolDetails({ tool, runId }: { tool: ToolCall; runId: string }) {
  const files = useMemo(() => tool.diff ? parseUnifiedDiff(tool.diff) : [], [tool.diff])
  const output = useMemo(() => {
    try {
      const result = JSON.parse(tool.output)
      const parts = Array.isArray(result) ? result : result?.content
      if (Array.isArray(parts)) return parts.filter((part: {type?: string}) => part?.type === "text").map((part: {text?: string}) => part.text ?? "").join("\n")
    } catch { /* Plain command output needs no decoding. */ }
    return tool.output
  }, [tool.output])
  return <div className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground">
    <div className="flex min-w-0 items-start gap-2">
      <span className="shrink-0">{tool.label}</span>
      {tool.title && <code className="min-w-0 break-all text-foreground">{tool.title}</code>}
      {took(tool) && <span className="ml-auto shrink-0 text-subtle">{took(tool)}</span>}
    </div>
    {tool.paths.length > 1 && <ul aria-label="Changed files" className="flex flex-col gap-1">{tool.paths.map(path => <li key={path}><code className="break-all text-foreground">{path}</code></li>)}</ul>}
    {tool.source && <span>Connection: {tool.source}</span>}
    {tool.summary && <span className={cn("break-words", tool.status === "failed" && "text-failed")}>{tool.summary}</span>}
    {files.length > 0 && <div className="max-h-72 overflow-auto rounded border border-border bg-card"><DiffView lines={files.flatMap(file => file.lines)} /></div>}
    {output && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-card px-3 py-2 text-[11px] leading-5" style={mono}>{output}</pre>}
    <ToolImages tool={tool} runId={runId} />
  </div>
}

function ToolActivity({ tools, runId, live, group }: { tools: ToolCall[]; runId: string; live: boolean; group?: "explore" | "edits" }) {
  const failed = tools.some(tool => tool.status === "failed")
  const running = tools.some(tool => tool.status === "running")
  const interrupted = running && !live && !failed
  const label = interrupted ? "Activity interrupted" : group ? groupLabel(tools, group === "edits") : activityLabel(tools[0])
  const files = useMemo(() => tools.flatMap(tool => tool.diff ? parseUnifiedDiff(tool.diff) : []), [tools])
  const status = failed ? "error" : interrupted ? "pending" : running ? "running" : undefined
  const indicator = failed ? <CircleAlert /> : interrupted ? <CirclePause /> : running ? <LoaderCircle className="animate-spin text-warning motion-reduce:animate-none" /> : !group ? <Check className="text-ready" /> : undefined
  return <Trace aria-label="Agent activity">
    <TraceCollapsible className={cn("min-w-0", failed && "rounded border border-failed/30 bg-failed/5 px-3 py-1")}>
      <TraceCollapsibleTrigger indicator={indicator}>
        <TraceLine status={status} className="flex-1">
          <TraceTitle>{label}</TraceTitle>
          {files.length > 0 && <TraceDescription><DiffCounts add={files.reduce((n, f) => n + f.add, 0)} del={files.reduce((n, f) => n + f.del, 0)} /></TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      {failed && <p role="status" className="pb-1 pl-5 text-xs text-failed">{group ? "An action failed. Open details to see what happened." : "Open details to see what happened."}</p>}
      <TraceCollapsibleContent><div className="flex min-w-0 flex-col gap-4">{tools.map(tool => <ToolDetails key={tool.callId} tool={tool} runId={runId} />)}</div></TraceCollapsibleContent>
    </TraceCollapsible>
  </Trace>
}

function AgentsBlock({ agents }: { agents: SubAgent[] }) {
  const running = agents.filter((a) => a.status === "running").length
  return (
    <div className="text-[13px] leading-[22px]" style={mono}>
      <div className="flex items-center gap-2.5">
        <Dot status={running ? "working" : "ready"} size={7} />
        <span className="font-medium text-foreground">Agents</span>
        <span className="text-muted-foreground">· {running ? `${running} running` : `${agents.length} done`}</span>
      </div>
      <div className="pl-[3px]">
        {agents.map((a, i) => (
          <div key={a.id} className="flex items-center gap-2 text-[12px]">
            <span className="text-subtle">{i === agents.length - 1 ? "└" : "├"}</span>
            <Dot status={a.status === "running" ? "working" : a.status === "failed" ? "failed" : "ready"} size={5} />
            <span className="w-[92px] shrink-0 truncate text-foreground">{a.kind}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.status === "running" ? a.activity || a.description : a.description}</span>
            <span className="text-subtle tabular-nums">{a.elapsedMs ? duration(a.elapsedMs) : ""}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolImages({ tool, runId }: { tool: ToolCall; runId: string }) {
  if (!tool.images?.length) return null
  return (
    <div className="mt-2 flex flex-wrap gap-3">
      {tool.images.map((image, i) => (
        <figure key={image.id} className="flex flex-col gap-1">
          <MessageImage runId={runId} id={image.id} alt={tool.name === "browser" ? `${i === 0 ? "Wide" : "Phone"} browser screenshot` : `Tool image ${i + 1}`} />
          {tool.name === "browser" && <figcaption className="text-[11px] text-muted-foreground">{i === 0 ? "Wide" : "Phone"}</figcaption>}
        </figure>
      ))}
    </div>
  )
}

function MessageImage({ runId, id, alt = "Attached image" }: { runId: string; id: string; alt?: string }) {
  const { data: url, isError } = useRunImage(runId, id)
  const box = "block size-24 shrink-0 overflow-hidden rounded-[4px] border border-border-strong bg-raised max-md:size-20"
  if (isError) return <span className={cn(box, "grid place-items-center px-2 text-center text-[11px] text-muted-foreground")}>Image unavailable</span>
  if (!url) return <span className={cn(box, "animate-pulse")} />
  return (
    <a href={url} target="_blank" rel="noreferrer" className={cn(box, "transition-colors hover:border-muted-foreground")} title="Open full size">
      <img src={url} alt={alt} className="size-full object-cover" />
    </a>
  )
}

function UserMessage({
  text,
  ts,
  author,
  authorId,
  base,
  first,
  runId,
  images = [],
}: {
  text: string
  ts: number
  author: string
  authorId: string
  base: string
  first: boolean
  runId: string
  images?: { id: string }[]
}) {
  const { data: me } = useMe()
  return (
    <div className="rounded-[4px] border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
        {authorId === me?.user?.id ? <ProfileAvatar src={me.user.image} size={24} label="Your profile photo" /> : <ProfileAvatar size={24} label={`${author} profile photo`} />}
        <span className="font-medium text-foreground">{author}</span>
        <span>· {ago(ts)}</span>
        {first && (
          <span className="ml-auto inline-flex items-center gap-1.5">
            <GitPullRequestArrow className="size-3.5" /> PR into{" "}
            <span className="text-foreground" style={mono}>
              {base}
            </span>
          </span>
        )}
      </div>
      {text && <p className="text-[14px] leading-[1.6] whitespace-pre-wrap text-foreground">{text}</p>}
      {images.length > 0 && (
        <div className={cn("flex flex-wrap gap-2", text && "mt-3")}>
          {images.map((i) => (
            <MessageImage key={i.id} runId={runId} id={i.id} />
          ))}
        </div>
      )}

    </div>
  )
}

function EndMarker({ status, error }: { status: RunStatus; error?: string }) {
  if (status === "merged") return <div><StatusPill status="merged" /></div>
  const ui = RUN_UI[status]
  const text = status === "failed" ? (error ?? ui.endText) : ui.endText
  return (
    <Tool status={status === "failed" ? "failed" : "done"} name={ui.label}>
      <Branch>
        <span className={status === "failed" ? "text-failed" : ""}>{text}</span>
      </Branch>
    </Tool>
  )
}

export function TranscriptView({ run, t, author }: { run: Run; t: Transcript; author: string }) {
  const live = (t.status ?? run.status) === "working" || (t.status ?? run.status) === "queued"
  const busyTool = t.items.some(item => item.kind === "tool" ? item.tool.status === "running" : (item.kind === "explore" || item.kind === "edits") && item.tools.some(tool => tool.status === "running"))
  const headings = useMemo(() => {
    const keys = new Set<string>()
    let first = true
    for (const item of t.items) {
      if (item.kind === "user" || item.kind === "run-message") first = true
      else if (item.kind === "text" && first) { keys.add(item.key); first = false }
    }
    return keys
  }, [t.items])
  const firstUser = t.items.find((i) => i.kind === "user")?.key
  const render = (it: Item) => {
    switch (it.kind) {
      case "user":
        return (
          <UserMessage
            key={it.key}
            text={it.text}
            ts={it.ts}
            images={it.images}
            runId={run.id}
            author={author}
            authorId={run.user_id}
            base={run.base_branch}
            first={it.key === firstUser}
          />
        )
      case "shared-image":
        return <SharedImage key={it.key} runId={run.id} imageId={it.imageId} caption={it.caption} />
      case "run-message":
        return <p key={it.key} role="status" className="text-xs text-muted-foreground">{it.text}</p>
      case "text": {
        return <section key={it.key} className="flex min-w-0 flex-col gap-2.5">
          {headings.has(it.key) && <AgentLabel />}
          <Prose text={it.text} />
        </section>
      }
      case "explore":
      case "edits":
        return <ToolActivity key={it.key} tools={it.tools} group={it.kind} runId={run.id} live={live} />
      case "tool":
        return <ToolActivity key={it.key} tools={[it.tool]} runId={run.id} live={live} />
      case "plan":
        return <PlanCard key={it.key} steps={it.steps} />
      case "agents":
        return <AgentsBlock key={it.key} agents={it.agents} />
      case "released":
        return <p key={it.key} role="status" className="text-xs text-muted-foreground">Idle workspace closed to make room for waiting work. Send a follow-up to reopen it with saved progress when available.</p>
      case "compacted":
        return <p key={it.key} className="text-xs text-muted-foreground">
          Context compacted
          {it.before !== undefined && it.after !== undefined && <> · {it.before.toLocaleString()} → ~{it.after.toLocaleString()} tokens</>}
        </p>
      case "pr":
        return (
          <a key={it.key} href={it.url} target="_blank" rel="noreferrer" className="w-fit rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
            <PrChip status={run.status} state={it.number === run.pr_number ? run.pr_state : it.state} number={it.number} />
          </a>
        )
      case "end":
        return <EndMarker key={it.key} status={it.status} error={it.error} />
    }
  }
  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-8 pt-6 pb-8 max-md:px-4 max-md:pt-4">
      {t.items.length === 0 && <UserMessage text={run.prompt} ts={run.created_at} runId={run.id} author={author} authorId={run.user_id} base={run.base_branch} first />}
      {t.items.map(render)}
      {live && run.status !== "queued" && !busyTool && (
        <Activity label={t.step ?? run.step ?? "Working"} />
      )}
    </div>
  )
}
