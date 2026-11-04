import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react"
import type { ReactNode } from "react"
import { MODEL_PROVIDER_ICONS } from "@shared/provider-icons"
import { GondAgentMark } from "@shared/logo"
import { providerOf } from "@shared/providers"
import { cn } from "@/lib/utils"
import type { Run, RunStatus } from "@/lib/api"
import { Badge } from "@shared/ui/badge"
import { RUN_UI } from "@/lib/run-state"
import { STATUS, mono } from "./theme"
import { compactCount } from "@/lib/format"

const statusColor: Record<RunStatus, string> = STATUS

/** The TUI's ● bullet. Working gets a soft breathing halo. */
export function Dot({ status, className, size = 7 }: { status: RunStatus; className?: string; size?: number }) {
  const c = statusColor[status]
  const live = status === "working"
  const hollow = status === "queued"
  return (
    <span className={cn("relative inline-grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      {live && (
        <span
          className="absolute rounded-full motion-safe:animate-ping"
          style={{ inset: -2, background: c, opacity: 0.25, animationDuration: "2.2s" }}
        />
      )}
      <span
        className="relative rounded-full"
        style={hollow ? { width: size, height: size, boxShadow: `inset 0 0 0 1.5px ${c}` } : { width: size, height: size, background: c }}
      />
    </span>
  )
}

export function StatusPill({ status, children }: { status: RunStatus; children?: ReactNode }) {
  const ui = RUN_UI[status]
  return <Badge variant={ui.variant} className="shrink-0 whitespace-nowrap">{status === "merged" ? <GitMerge className="size-3" /> : <Dot status={status} size={6} />}{children ?? ui.label}</Badge>
}

/** The xAI mark (Grok models). */
function XaiGlyph({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" fillRule="evenodd" aria-hidden="true">
      <path d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z" />
    </svg>
  )
}


export { PROVIDER_LABEL, providerOf } from "@shared/providers"

/** "Claude Sonnet 5.5" → "Sonnet 5.5"; falls back to the id. */
export function shortModel(name: string | undefined, id: string): string {
  return (name ?? id).replace(/^Claude /, "")
}

export function ModelMark({ id, provider: fallback, className, size = 16 }: { id: string; provider?: string; className?: string; size?: number }) {
  const identified = providerOf(id)
  const provider = identified === "other" ? fallback ?? identified : identified
  const src = MODEL_PROVIDER_ICONS[provider]
  // Keep the provider's real mark for API and subscription models; Auto uses Gond's mark.
  return (
    <span aria-hidden="true" data-model-provider={provider} className={cn("inline-grid shrink-0 place-items-center text-foreground/80", className)} style={{ width: size, height: size }}>
      {provider === "auto" ? (
        <GondAgentMark size={size * 0.82} />
      ) : src ? (
        <span
          className={cn("bg-contain bg-center bg-no-repeat", ["openai", "moonshot", "qwen", "zai", "minimax"].includes(provider) && "dark:invert")}
          style={{ backgroundImage: `url("${src}")`, width: size * 0.82, height: size * 0.82 }}
        />
      ) : provider === "xai" ? (
        <XaiGlyph size={size * 0.82} />
      ) : null}
    </span>
  )
}

/** Five-square diff bar, echoing the brand mark: green for additions, red for deletions. */
export function DiffSquares({ add, del, className }: { add: number; del: number; className?: string }) {
  // Like GitHub's diffstat: how many squares light up scales with the size of the change.
  const total = add + del
  const lit = total === 0 ? 0 : Math.min(5, Math.max(1, Math.round(Math.log2(total + 1) / 1.45)))
  const r = del === 0 ? 0 : Math.max(1, Math.round((del / total) * lit))
  const g = add === 0 ? 0 : Math.max(1, lit - r)
  return (
    <span data-diff-squares className={cn("inline-flex shrink-0 gap-[3px]", className)} aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className="size-[7px] rounded-[2px]"
          style={{ background: i < g ? "var(--diff-add)" : i < g + r ? "var(--diff-del)" : "var(--border-strong)" }}
        />
      ))}
    </span>
  )
}

export function DiffCounts({ add, del, compact = false, className }: { add: number; del: number; compact?: boolean; className?: string }) {
  return (
    <span data-diff-counts title={`+${add} −${del}`} className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[12px] tabular-nums", className)} style={mono}>
      <span className="text-diff-add">+{compact ? compactCount(add) : add}</span>
      <span className="text-diff-del">−{compact ? compactCount(del) : del}</span>
    </span>
  )
}

/** The square card from Cursor's list, reimagined: file count, counts, and the five-square bar. */
export function DiffTile({ files, add, del, status }: { files: number; add: number; del: number; status: RunStatus }) {
  return (
    <div data-diff-tile className="relative flex h-[66px] w-[112px] shrink-0 flex-col justify-between rounded-[4px] border border-border bg-background px-2.5 pt-2 pb-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground" title={String(files)}>{files ? compactCount(files) : "—"}</span> {files === 1 ? "file" : "files"}
        </span>
        {status === "working" && <Dot status="working" size={5} />}
      </div>
      {files ? <DiffCounts add={add} del={del} compact className="text-[11px]" /> : <span className="text-[11px] text-subtle">waiting</span>}
      <DiffSquares add={add} del={del} />
    </div>
  )
}

/** Right-hand PR column: what happened to the pull request. */
export function PrChip({ status, state, number, files }: { status: RunStatus; state?: Run["pr_state"]; number?: number | null; files?: number }) {
  const pr = RUN_UI[status].pr
  if (!number && pr === "pending") return <span className="text-[12px] text-subtle">PR on finish</span>
  const map = {
    ready: { icon: GitPullRequest, color: STATUS.ready, label: number ? "Open" : files ? "No PR" : "No changes" },
    merged: { icon: GitMerge, color: STATUS.merged, label: "Merged" },
    none: { icon: GitPullRequestClosed, color: STATUS.stopped, label: "No PR" },
    pending: { icon: GitPullRequest, color: STATUS.working, label: "PR on finish" },
  } as const
  const s = number ? state === "merged" || status === "merged" ? map.merged : state === "closed" ? { icon: GitPullRequestClosed, color: STATUS.failed, label: "Closed" } : map.ready : map[pr]
  const Icon = s.icon
  return (
    <span aria-label={number ? `${s.label} pull request #${number}` : undefined} className="inline-flex items-center gap-1.5 text-[12px]">
      <Icon className="size-3.5" style={{ color: s.color }} />
      {number ? (
        <span className="text-foreground tabular-nums" style={mono}>
          #{number}
        </span>
      ) : null}
      <span className="text-muted-foreground">{s.label}</span>
    </span>
  )
}
