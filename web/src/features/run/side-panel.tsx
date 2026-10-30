// The run page's details panel: changes, the pull request, and logs.
import { Copy, ExternalLink, FileCode2, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { Tabs, TabsList, TabsTrigger } from "@shared/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle } from "@shared/ui/card"
import { Button } from "@shared/ui/button"
import type { Run } from "@/lib/api"
import { ago, repoName, runElapsed } from "@/lib/format"
import { useCreatePull, useGithub, useMe, useMergeRun, useRunDiff } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { DiffView, type FileDiff, parseUnifiedDiff } from "@shared/diff"
import { DiffCounts, DiffSquares, ModelMark, shortModel } from "../studio/parts"
import { mono, tabs } from "../studio/theme"
import type { Transcript } from "./transcript"
import { Prose } from "./transcript-view"

/* ───────────── right panel ───────────── */

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] text-muted-foreground">{label}</div>
      <div className="mt-1 flex min-w-0 items-center gap-1.5 truncate text-[13px] text-foreground">{children}</div>
    </div>
  )
}

function ChangesTab({ run, files }: { run: Run; files: FileDiff[] }) {
  const [sel, setSel] = useState<string | null>(null)
  const current = files.find((f) => f.path === sel) ?? files[0]
  if (!current) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center text-[13px] text-muted-foreground">
        {run.status === "working" || run.status === "queued" ? "Changed files show up here as the agent edits them." : "This run didn't change any files."}
      </div>
    )
  }
  return (
    <>
      <ul className="max-h-[40%] space-y-0.5 overflow-y-auto px-2.5 pt-2.5">
        {files.map((f) => {
          const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/") + 1) : ""
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setSel(f.path)}
                className={cn("flex h-8 w-full items-center gap-2.5 rounded-[4px] px-2.5 text-left text-[12px]", f === current ? "bg-accent-soft" : "hover:bg-raised/60")}
              >
                <span className={cn("w-3 text-center text-[11px] font-medium", f.status === "A" ? "text-diff-add" : f.status === "D" ? "text-diff-del" : "text-muted-foreground")} style={mono}>
                  {f.status}
                </span>
                <span className="min-w-0 flex-1 truncate" style={mono}>
                  <span className="text-muted-foreground">{dir}</span>
                  <span className="text-foreground">{f.path.slice(dir.length)}</span>
                </span>
                <DiffCounts add={f.add} del={f.del} className="text-[12px]" />
                <DiffSquares add={f.add} del={f.del} />
              </button>
            </li>
          )
        })}
      </ul>
      <div className="min-h-0 flex-1 px-3 pt-3 pb-3">
        <Card className="h-full rounded-[4px] border-border bg-card">
          <CardHeader className="flex-row items-center justify-between py-2 pr-2 pl-3.5">
            <div className="flex min-w-0 items-center gap-2">
              <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
              <CardTitle className="truncate text-[12px] font-medium" style={mono}>
                {current.path}
              </CardTitle>
              <DiffCounts add={current.add} del={current.del} className="text-[12px]" />
            </div>
            <div>
              <Button variant="ghost" size="icon" aria-label="Copy path" onClick={() => void navigator.clipboard.writeText(current.path)}><Copy /></Button>
              {run.pr_url && (
                <Button variant="ghost" size="icon" aria-label="Open on GitHub" onClick={() => window.open(`https://github.com/${run.repo}/blob/${run.branch}/${current.path}`, "_blank", "noopener")}><ExternalLink /></Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="overflow-auto p-0 py-1">
            <DiffView lines={current.lines} />
          </CardContent>
        </Card>
      </div>
    </>
  )
}

function PullRequestTab({ run, summary }: { run: Run; summary: string }) {
  const merge = useMergeRun()
  const create = useCreatePull()
  const github = useGithub()
  const { data: me } = useMe()
  const merged = run.status === "merged" || run.pr_state === "merged"
  const open = !!run.pr_number && !merged && run.pr_state !== "closed"
  const busy = run.status === "working" || run.status === "queued"
  // Automations → Open pull requests automatically is off: the branch is on GitHub, the PR waits for you.
  const canCreate = !run.pr_number && !busy && !merged && !!run.live?.pushed
  const branchUrl = `https://github.com/${run.repo}/tree/${run.branch.split("/").map(encodeURIComponent).join("/")}`
  const badge = merged
    ? { icon: GitMerge, label: "Merged", cls: "bg-merged/15 text-merged" }
    : run.pr_state === "closed"
      ? { icon: GitPullRequestClosed, label: "Closed", cls: "bg-raised text-muted-foreground" }
      : run.pr_number
        ? { icon: GitPullRequest, label: "Open", cls: "bg-ready/15 text-ready" }
        : { icon: GitPullRequestDraft, label: "Not opened yet", cls: "bg-raised text-muted-foreground" }
  const Icon = badge.icon
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-3 pb-4">
      <div className="rounded-[4px] border border-border bg-card p-4">
        <div className="flex items-center gap-2 text-[12px]">
          <span className={cn("inline-flex h-5 items-center gap-1.5 rounded-[4px] px-1.5 font-medium", badge.cls)}>
            <Icon className="size-3.5" /> {badge.label}
          </span>
          {run.pr_number && (
            <span className="text-muted-foreground" style={mono}>
              #{run.pr_number}
            </span>
          )}
        </div>
        <h3 className="mt-2.5 text-[14px] font-semibold text-foreground">{run.title}</h3>
        <div className="mt-1.5 flex items-center gap-1.5 text-[12px] text-muted-foreground" style={mono}>
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate text-foreground">{run.branch}</span>
          <span>→</span>
          <span className="text-foreground">{run.base_branch}</span>
        </div>
        {summary && (
          <div className="mt-3">
            <Prose text={summary} small />
          </div>
        )}
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-[12px] text-muted-foreground">
          <DiffCounts add={run.additions} del={run.deletions} />
          <DiffSquares add={run.additions} del={run.deletions} />
          <span>
            · {run.files} {run.files === 1 ? "file" : "files"}
          </span>
        </div>
      </div>


      {open ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={merge.isPending}
              onClick={() => merge.mutate({ id: run.id, arg: undefined })}
              className="inline-flex h-9 items-center gap-2 rounded-[4px] bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
            >
              <GitMerge className="size-4" /> {merge.isPending ? "Merging…" : "Squash and merge"}
            </button>
            <a
              href={run.pr_url!}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-border-strong px-3 text-[13px] text-foreground transition-colors hover:bg-raised"
            >
              Review on GitHub <ExternalLink className="size-3.5" />
            </a>
          </div>
          {merge.error && <p className="text-[12px] text-failed">{merge.error.message}</p>}
        </div>
      ) : canCreate ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={create.isPending}
              onClick={() => create.mutate({ id: run.id, arg: undefined })}
              className="inline-flex h-9 items-center gap-2 rounded-[4px] bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
            >
              <GitPullRequest className="size-4" /> {create.isPending ? "Creating…" : "Create pull request"}
            </button>
            <a
              href={branchUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-border-strong px-3 text-[13px] text-foreground transition-colors hover:bg-raised"
            >
              View branch <ExternalLink className="size-3.5" />
            </a>
          </div>
          {create.error ? (
            <p className="text-[12px] text-failed">{create.error.message}</p>
          ) : (
            <p className="px-1 text-[12px] leading-[1.6] text-muted-foreground">The changes are on the branch. Ask for more in the chat, or open the pull request when they're ready.</p>
          )}
        </div>
      ) : merged && run.pr_url ? (
        <a href={run.pr_url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-border-strong px-3 text-[13px] text-foreground hover:bg-raised">
          View on GitHub <ExternalLink className="size-3.5" />
        </a>
      ) : (
        <p className="px-1 text-[12px] leading-[1.6] text-muted-foreground">
          {busy
            ? me?.automations?.auto_pr === false
              ? "The agent pushes its changes to the branch when it finishes. You open the pull request."
              : "The agent opens the pull request when it finishes. Review it here or on GitHub."
            : github.data?.configured === false
              ? "GitHub isn't connected, so the changes weren't pushed."
              : run.files === 0
                ? "No pull request: the agent didn't change any files."
                : "No pull request was opened for this run."}
        </p>
      )}
    </div>
  )
}

function LogsTab({ t }: { t: Transcript }) {
  const start = t.startedAt ?? 0
  return (
    <div className="min-h-0 flex-1 px-3 pt-3 pb-3">
      <div className="h-full overflow-y-auto rounded-[4px] border border-border bg-card px-3 py-2.5 text-[12px] leading-[22px]" style={mono}>
        {t.log.length === 0 && <span className="text-subtle">Nothing yet</span>}
        {t.log.map((l, i) => {
          const s = Math.max(0, Math.round((l.ts - start) / 1000))
          return (
            <div key={i} className="flex gap-3">
              <span className="w-10 shrink-0 text-subtle tabular-nums">
                {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
              </span>
              <span className="w-14 shrink-0 text-muted-foreground">{l.source}</span>
              <span className="min-w-0 flex-1 truncate text-foreground">{l.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function SidePanel({ run, t, modelName, className }: { run: Run; t: Transcript; modelName?: string; className?: string }) {
  const live = run.status === "working" || run.status === "queued"
  const [tab, setTab] = useState(run.pr_number ? "pr" : "changes")
  const committed = !live || t.committed > 0
  const diff = useRunDiff(run.id, t.committed + (live ? 0 : 1))
  const files = useMemo(
    () => parseUnifiedDiff(committed && diff.data ? diff.data : t.editDiffs.join("\n")),
    [committed, diff.data, t.editDiffs],
  )
  const summary = [...t.items].reverse().find((i) => i.kind === "text")?.text ?? ""
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [live])
  return (
    <aside className={cn("flex h-full min-h-0 flex-col border-l border-border bg-card max-md:border-l-0", className)}>
      <div className="grid grid-cols-3 gap-x-4 gap-y-4 border-b border-border px-5 py-4 max-md:grid-cols-2 max-md:gap-y-3 max-md:px-4">
        <Fact label="Repository">
          <span className="truncate" title={run.repo}>
            {repoName(run.repo)}
          </span>
        </Fact>
        <Fact label="Branch">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-[12px]" style={mono} title={run.branch}>
            {run.branch.replace(/^gond-agent\//, "")}
          </span>
        </Fact>
        <Fact label="Model">
          <ModelMark id={run.model_id} size={14} />
          {shortModel(modelName, run.model_id)}
        </Fact>
        <Fact label="Elapsed">
          <span className="tabular-nums" style={mono}>
            {runElapsed(run) ?? "—"}
          </span>
        </Fact>
        <Fact label="Started">{ago(run.created_at)}</Fact>
        <Fact label="Changes">
          <DiffCounts add={run.additions} del={run.deletions} />
        </Fact>
      </div>

      <div className="flex items-center justify-between px-4 pt-3">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className={tabs.list}>
            <TabsTrigger value="changes" className={tabs.trigger}>
              Changes {files.length > 0 && <span className="opacity-60">{files.length}</span>}
            </TabsTrigger>
            <TabsTrigger value="pr" className={tabs.trigger}>
              Pull request{" "}
              {run.pr_number && (
                <span className="opacity-60" style={mono}>
                  #{run.pr_number}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="logs" className={tabs.trigger}>
              Logs
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === "changes" ? <ChangesTab run={run} files={files} /> : tab === "pr" ? <PullRequestTab run={run} summary={summary} /> : <LogsTab t={t} />}

      {live && (
        <div className="flex items-center gap-3 border-t border-border px-5 py-3.5">
          <GitPullRequestDraft className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-[13px] leading-tight">
            <div className="text-foreground">The PR opens when the agent finishes</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              into <span style={mono}>{run.base_branch}</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
