import { GitMerge, GitPullRequest, GitPullRequestClosed, Sparkles } from "lucide-react"
import type { ReactNode } from "react"
import { MODEL_PROVIDER_ICONS } from "@shared/provider-icons"
import { providerOf } from "@shared/providers"
import { cn } from "@/lib/utils"
import type { RunStatus } from "@/lib/api"
import { Badge } from "@shared/ui/badge"
import { STATUS, mono, tint } from "./theme"

const statusColor: Record<RunStatus, string> = STATUS

const statusLabel: Record<RunStatus, string> = {
  queued: "Queued",
  working: "Working",
  ready: "PR ready",
  merged: "Merged",
  failed: "Failed",
  stopped: "Stopped",
}

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
  const variant = status === "ready" ? "good" : status === "working" || status === "queued" ? "warning" : status === "failed" ? "bad" : status === "merged" ? "info" : "neutral"
  return <Badge variant={variant} className="shrink-0 whitespace-nowrap"><Dot status={status} size={6} />{children ?? statusLabel[status]}</Badge>
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

export function ModelMark({ id, className, size = 16 }: { id: string; className?: string; size?: number }) {
  const provider = providerOf(id)
  const src = MODEL_PROVIDER_ICONS[provider]
  // xAI's mark is drawn inline, and Auto (Gond Agent's pick) gets a sparkle; a provider without an icon gets an
  // empty slot, never another's mark.
  return (
    <span className={cn("inline-grid shrink-0 place-items-center text-foreground/80", className)} style={{ width: size, height: size }}>
      {provider === "auto" ? (
        <Sparkles style={{ width: size * 0.82, height: size * 0.82 }} strokeWidth={1.75} aria-hidden />
      ) : src ? (
        <span
          className="bg-contain bg-center bg-no-repeat invert opacity-75"
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
    <span className={cn("inline-flex gap-[3px]", className)} aria-hidden="true">
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

export function DiffCounts({ add, del, className }: { add: number; del: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[12px] tabular-nums", className)} style={mono}>
      <span className="text-diff-add">+{add}</span>
      <span className="text-diff-del">−{del}</span>
    </span>
  )
}

/** The square card from Cursor's list, reimagined: file count, counts, and the five-square bar. */
export function DiffTile({ files, add, del, status }: { files: number; add: number; del: number; status: RunStatus }) {
  return (
    <div className="relative flex h-[66px] w-[84px] shrink-0 flex-col justify-between rounded-[4px] border border-border bg-background px-2.5 pt-2 pb-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">{files || "—"}</span> {files === 1 ? "file" : "files"}
        </span>
        {status === "working" && <Dot status="working" size={5} />}
      </div>
      {files ? <DiffCounts add={add} del={del} className="text-[11px]" /> : <span className="text-[11px] text-subtle">waiting</span>}
      <DiffSquares add={add} del={del} />
    </div>
  )
}

/** Right-hand PR column: what happened to the pull request. */
export function PrChip({ status, number, files }: { status: RunStatus; number?: number | null; files?: number }) {
  if (status === "working") return <span className="text-[12px] text-subtle">PR on finish</span>
  if (status === "queued") return <span className="text-[12px] text-subtle">PR on finish</span>
  const map = {
    ready: { icon: GitPullRequest, color: STATUS.ready, label: number ? "Open" : files ? "No PR" : "No changes" },
    merged: { icon: GitMerge, color: STATUS.merged, label: "Merged" },
    failed: { icon: GitPullRequestClosed, color: STATUS.stopped, label: "No PR" },
    stopped: { icon: GitPullRequestClosed, color: STATUS.stopped, label: "No PR" },
  } as const
  const s = map[status]
  const Icon = s.icon
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px]">
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

export function Avatar({ initials, color, size = 24, src }: { initials: string; color: string; size?: number; src?: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size, boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--foreground) 8%, transparent)" }}
      />
    )
  }
  return (
    <span
      className="inline-grid shrink-0 place-items-center rounded-full text-[11px] font-semibold"
      style={{ width: size, height: size, background: tint(color, 14), color, boxShadow: `inset 0 0 0 1px ${tint(color, 22)}` }}
    >
      {initials}
    </span>
  )
}
