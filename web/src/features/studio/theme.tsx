import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

// Shared dark-only surface, typography and lifecycle tokens.
export const STATUS = {
  queued: "var(--status-stopped)",
  working: "var(--status-working)",
  ready: "var(--status-ready)",
  merged: "var(--status-merged)",
  failed: "var(--status-failed)",
  stopped: "var(--status-stopped)",
} as const

/** Tint any CSS color: `tint(STATUS.ready, 14)` → 14% of the hue over transparent. */
export const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`


/**
 * Type scale. Inter for all UI text, JetBrains Mono for code, paths, branches, commands,
 * diffstats and tabular numbers. Sizes: 11 / 12 / 13 / 14 / 16 / 24 / 32 (40 for the
 * one hero figure). Weights: 400, 500, 600.
 */
export const T = {
  display: "text-[32px] font-semibold leading-[1.15] tracking-[-0.025em]",
  title: "text-[14px] font-semibold",
  body: "text-[14px]",
  ui: "text-[13px]",
  caption: "text-[12px]",
  micro: "text-[11px]",
} as const

export function StudioRoot({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("h-screen w-screen overflow-hidden bg-background font-sans text-foreground antialiased", className)}>
      {children}
    </div>
  )
}

export { MONO, mono } from "@shared/theme"

/** The composer's picker buttons (repository, branch, model): the look every picker trigger matches. */
export const pickerChip =
  "group inline-flex h-8 min-w-0 shrink-0 items-center gap-2 whitespace-nowrap rounded-[4px] border border-border-strong bg-raised/40 text-[13px] text-foreground transition-colors hover:bg-raised data-[state=open]:bg-raised disabled:opacity-50"

/** Tabs: a flat surface list; the active tab uses Gond's blue tint wash and ink. */
export const tabs = {
  list: "rounded-[4px] border border-border bg-surface p-[3px]",
  trigger: "gap-1.5 rounded-[3px] px-3 py-1 text-[13px] [&>[data-tabs-label]]:text-link",
  indicator: "!rounded-[3px] bg-accent-soft",
} as const
