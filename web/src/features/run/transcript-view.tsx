// A run's transcript on its page: messages, tools, plans and subagents (TUI language, softened).
import { Check, GitPullRequestArrow, Workflow } from "lucide-react"
import { type ReactNode, useMemo } from "react"
import { Activity } from "@/components/workspace/activity"
import { useSession } from "@/app/auth"
import type { Run, RunStatus } from "@/lib/api"
import { ago, avatarColor, duration, initials } from "@/lib/format"
import { useMe, useRunImage } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { DiffView, parseUnifiedDiff } from "@shared/diff"
import { Avatar, DiffCounts, Dot } from "../studio/parts"
import { STATUS, mono } from "../studio/theme"
import { type Item, type MessageSource, type PlanStep, type SubAgent, type ToolCall, type Transcript } from "./transcript"
import { Prose as SharedProse } from "@shared/prose"

/* ───────────── transcript pieces (TUI language, softened) ───────────── */

const TOOL_STATUS: Record<ToolCall["status"], RunStatus> = { done: "ready", running: "working", failed: "failed" }

const TOOL_LABEL: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multi_edit: "Edit",
  apply_patch: "Patch",
  bash: "Bash",
  kill_shell: "Stop shell",
  glob: "Find",
  grep: "Search",
  list_directory: "List",
  web_fetch: "Fetch",
  web_search: "Web search",
  symbols: "Symbols",
  batch: "Batch read",
  browser: "Browser test",
  finish_review: "Self-review",
  skill: "Skill",
}

const toolLabel = (name: string) => TOOL_LABEL[name] ?? name.replace(/^mcp__/, "").replace(/_/g, " ")

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

function ExploreGroup({ tools, runId }: { tools: ToolCall[]; runId: string }) {
  const files = tools.filter((t) => t.name === "read").length
  const searches = tools.length - files
  const running = tools.some((t) => t.status === "running")
  const parts = [files && `${files} ${files === 1 ? "file" : "files"}`, searches && `${searches} ${searches === 1 ? "search" : "searches"}`].filter(Boolean)
  const span = tools.at(-1)?.end ? duration(tools.at(-1)!.end! - tools[0]!.start) : undefined
  return (
    <Tool status={running ? "running" : "done"} name={running ? "Exploring" : "Explored"} arg={parts.join(", ")} right={span && <span className="text-[12px] text-subtle">{span}</span>}>
      {tools.map((t, i) => (
        <Branch key={t.callId} last={i === tools.length - 1}>
          {toolLabel(t.name)} <span className="text-foreground">{t.title}</span>
          {t.summary && <span> · {t.summary}</span>}
          <ToolImages tool={t} runId={runId} />
        </Branch>
      ))}
    </Tool>
  )
}

function ToolBlock({ tool, runId }: { tool: ToolCall; runId: string }) {
  const files = useMemo(() => (tool.diff ? parseUnifiedDiff(tool.diff) : []), [tool.diff])
  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)
  const lines = files.flatMap((f) => f.lines)
  const right = tool.diff ? <DiffCounts add={add} del={del} /> : took(tool) ? <span className="text-[12px] text-subtle">{took(tool)}</span> : undefined
  const outLines = tool.output.trimEnd().split("\n").filter((l, i, a) => l || i < a.length - 1)
  return (
    <Tool status={tool.status} name={toolLabel(tool.name)} arg={tool.title} right={right}>
      {lines.length > 0 ? (
        <Branch>
          <div className="mt-1.5 overflow-hidden rounded-[4px] border border-border bg-card">
            <DiffView lines={lines.slice(0, 10)} />
            {lines.length > 10 && (
              <div className="border-t border-border px-3 py-1.5 text-[12px] text-muted-foreground" style={mono}>
                + {lines.length - 10} more lines
              </div>
            )}
          </div>
        </Branch>
      ) : tool.name === "bash" && outLines.length > 0 ? (
        <Branch>
          <pre className="mt-1.5 max-h-40 overflow-hidden rounded-[4px] border border-border bg-card px-3 py-2 text-[12px] leading-[20px] whitespace-pre-wrap text-muted-foreground">
            {outLines.slice(-6).join("\n")}
          </pre>
        </Branch>
      ) : tool.summary ? (
        <Branch>
          <span className={tool.status === "failed" ? "text-failed" : ""}>{tool.summary}</span>
        </Branch>
      ) : null}
      <ToolImages tool={tool} runId={runId} />
    </Tool>
  )
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
  source,
}: {
  text: string
  ts: number
  author: string
  authorId: string
  base: string
  first: boolean
  runId: string
  images?: { id: string }[]
  source?: MessageSource
}) {
  const session = useSession()
  // Failing checks are sent by Gond Agent, not typed by the person: say so instead of showing their name.
  if (source?.kind === "checks") {
    author = "Gond Agent"
    authorId = "gond-agent"
  }
  const { data: me } = useMe()
  return (
    <div className="rounded-[4px] border border-border bg-surface p-4">
      <div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
        <Avatar initials={initials(author)} color={avatarColor(authorId)} size={20} src={authorId === me?.user?.id ? session.imageUrl : undefined} />
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
      {source && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-[12px] text-muted-foreground">
          <Workflow className="size-3.5" />
          {source.kind === "issue" ? (
            <span>
              From GitHub issue{" "}
              <a href={source.url} target="_blank" rel="noreferrer" className="text-foreground hover:underline">
                #{source.number}
              </a>{" "}
              · Automations
            </span>
          ) : (
            <span>
              Checks failed on{" "}
              <span className="text-foreground" style={mono}>
                {source.sha.slice(0, 7)}
              </span>{" "}
              · sent by Automations
            </span>
          )}
        </div>
      )}

    </div>
  )
}

function EndMarker({ status, error }: { status: RunStatus; error?: string }) {
  const text = status === "failed" ? (error ?? "The run failed") : status === "stopped" ? "Stopped" : "Pull request merged"
  return (
    <Tool status={status === "failed" ? "failed" : "done"} name={status === "failed" ? "Failed" : status === "stopped" ? "Stopped" : "Merged"}>
      <Branch>
        <span className={status === "failed" ? "text-failed" : ""}>{text}</span>
      </Branch>
    </Tool>
  )
}

export function TranscriptView({ run, t, author }: { run: Run; t: Transcript; author: string }) {
  const live = (t.status ?? run.status) === "working" || (t.status ?? run.status) === "queued"
  const lastItem = t.items.at(-1)
  const busyTool = lastItem?.kind === "tool" && lastItem.tool.status === "running"
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
            source={it.source}
            runId={run.id}
            author={author}
            authorId={run.user_id}
            base={run.base_branch}
            first={it.key === firstUser}
          />
        )
      case "text":
        return <Prose key={it.key} text={it.text} />
      case "explore":
        return <ExploreGroup key={it.key} tools={it.tools} runId={run.id} />
      case "tool":
        return <ToolBlock key={it.key} tool={it.tool} runId={run.id} />
      case "plan":
        return <PlanCard key={it.key} steps={it.steps} />
      case "agents":
        return <AgentsBlock key={it.key} agents={it.agents} />
      case "pr":
        return (
          <Tool key={it.key} name="Opened" arg={`PR #${it.number} → ${run.base_branch}`}>
            <Branch>
              <a href={it.url} target="_blank" rel="noreferrer" className="text-link hover:underline">
                {it.url.replace("https://", "")}
              </a>
            </Branch>
          </Tool>
        )
      case "end":
        return <EndMarker key={it.key} status={it.status} error={it.error} />
    }
  }
  return (
    <div className="mx-auto w-full max-w-[720px] space-y-5 px-8 pt-6 pb-8 max-md:px-4 max-md:pt-4">
      {t.items.length === 0 && <UserMessage text={run.prompt} ts={run.created_at} runId={run.id} author={author} authorId={run.user_id} base={run.base_branch} first />}
      {t.items.map(render)}
      {live && !busyTool && (
        <Activity label={t.step ?? run.step ?? "Working"} />
      )}
    </div>
  )
}
