import type { RunStatus } from "../../../shared/run-state"

type RunPresentation = {
  label: string
  color: string
  variant: "good" | "warning" | "bad" | "merged" | "neutral"
  pr: "pending" | "ready" | "merged" | "none"
  endText: string | null
}

/** Every persisted state must have a visible label and an explicit presentation. */
export const RUN_UI = {
  queued: { label: "Queued", color: "var(--status-stopped)", variant: "warning", pr: "pending", endText: null },
  working: { label: "Working", color: "var(--status-working)", variant: "warning", pr: "pending", endText: null },
  ready: { label: "PR ready", color: "var(--status-ready)", variant: "good", pr: "ready", endText: null },
  failed: { label: "Failed", color: "var(--status-failed)", variant: "bad", pr: "none", endText: "The run failed" },
  stopped: { label: "Stopped", color: "var(--status-stopped)", variant: "neutral", pr: "none", endText: "Stopped" },
  merged: { label: "Merged", color: "var(--status-merged)", variant: "merged", pr: "merged", endText: "Pull request merged" },
  interrupted: { label: "Interrupted", color: "var(--status-working)", variant: "warning", pr: "none", endText: "Interrupted. Resume to continue from saved progress." },
} as const satisfies Record<RunStatus, RunPresentation>

export const STATUS = Object.fromEntries(Object.entries(RUN_UI).map(([state, ui]) => [state, ui.color])) as Record<RunStatus, string>
