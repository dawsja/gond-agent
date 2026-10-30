// The hero: a agent run, replayed in a dark panel styled like the web app (your-server/agents). A task
// is typed against a repo, the agent works on its own machine, and a pull request comes back. Everything
// is laid out from the start (unrevealed parts are invisible), so the panel never changes height.
import { Check, ChevronDown, GitBranch, GitPullRequest, LoaderCircle, RotateCcw } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { CLOUD_RUN } from "@/content"
import { cn } from "@/lib/utils"

type Snapshot = {
  /** Characters of the task typed into the message box (before it's sent). */
  typed: number
  /** The run view has replaced the composer. */
  sent: boolean
  /** How many log lines are shown. */
  lines: number
  /** What the agent is doing right now (null once it's finished). */
  step: string | null
  /** The pull request card is shown. */
  pr: boolean
}

type Frame = { delay: number; state: Snapshot }

const TASK = CLOUD_RUN.task
const START: Snapshot = { typed: 0, sent: false, lines: 0, step: null, pr: false }
const END: Snapshot = { typed: TASK.length, sent: true, lines: CLOUD_RUN.log.length, step: null, pr: true }

function buildFrames(): Frame[] {
  const frames: Frame[] = []
  const push = (delay: number, s: Partial<Snapshot>) => {
    const prev = frames.at(-1)?.state ?? START
    frames.push({ delay, state: { ...prev, ...s } })
  }
  for (let n = 2; n < TASK.length + 2; n += 2) push(n === 2 ? 800 : 36, { typed: Math.min(n, TASK.length) })
  push(700, { sent: true, step: "Starting a worker" })
  CLOUD_RUN.log.forEach((line, i) => {
    push(i === 0 ? 1300 : line.kind === "test" ? 1500 : 700, { lines: i + 1, step: line.step ?? null })
  })
  push(900, { step: "Opening pull request" })
  push(1100, { step: null, pr: true })
  return frames
}

const frames = buildFrames()
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches

export function CloudRunReplay({ className }: { className?: string }) {
  const [reduced] = useState(reducedMotion)
  const [step, setStep] = useState(reduced ? -1 : 0) // -1 = final state
  const [started, setStarted] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (reduced || started) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setStarted(true), { threshold: 0.25 })
    io.observe(el)
    return () => io.disconnect()
  }, [reduced, started])

  useEffect(() => {
    if (!started || step < 0 || step >= frames.length) return
    const t = window.setTimeout(() => setStep(step + 1), frames[step].delay)
    return () => window.clearTimeout(t)
  }, [started, step])

  const s: Snapshot = step < 0 ? END : step === 0 ? START : frames[step - 1].state
  const done = s.pr

  return (
    <div ref={ref} className={cn("on-dark overflow-hidden rounded-[4px] border border-(--rule-strong) bg-(--term) text-(--term-fg)", className)}>
      {/* Window bar */}
      <div className="relative flex h-10 items-center justify-center border-b border-white/[0.07] bg-(--term-bar) px-4">
        <span className="font-mono text-xs text-(--term-dim)">your-server/agents</span>
        {done && !reduced ? (
          <button
            type="button"
            onClick={() => setStep(0)}
            className="absolute right-2 flex h-8 items-center gap-1.5 rounded-[3px] px-2.5 text-xs text-(--term-dim) transition-colors hover:text-(--term-bright)"
          >
            <RotateCcw aria-hidden className="size-3.5" />
            Replay
          </button>
        ) : null}
      </div>

      <div className="sr-only">
        <p>
          An example agent run: the task “{TASK}” on {CLOUD_RUN.repo}. The agent works on its own machine
          ({CLOUD_RUN.log.map((l) => l.text).join("; ")}) and opens pull request #{CLOUD_RUN.pr.number}, “{CLOUD_RUN.pr.title}”, with
          {` +${CLOUD_RUN.pr.add} −${CLOUD_RUN.pr.del}`} across {CLOUD_RUN.pr.files} files; tests passed.
        </p>
      </div>

      <div aria-hidden className="grid grid-cols-[minmax(0,1fr)] p-4 sm:p-6">
        {/* Compose and run share one grid cell, so the panel keeps the run's height throughout. */}
        <Composer s={s} />
        <Run s={s} />
      </div>
    </div>
  )
}

const chip = "inline-flex h-7 items-center gap-1.5 rounded-[3px] border border-white/[0.12] px-2 text-[12px] text-(--term-fg)"

function Composer({ s }: { s: Snapshot }) {
  return (
    <div className={cn("col-start-1 row-start-1 self-start transition-opacity duration-300", s.sent && "pointer-events-none opacity-0")}>
      <div className="flex flex-wrap gap-2">
        <span className={chip}>
          <GitHubMark /> <span className="text-(--term-dim)">acme /</span> <span className="font-medium">web</span>
          <ChevronDown className="size-3 text-(--term-dim)" />
        </span>
        <span className={chip}>
          <GitBranch className="size-3 text-(--term-dim)" /> <span className="font-mono">{CLOUD_RUN.base}</span>
          <ChevronDown className="size-3 text-(--term-dim)" />
        </span>
      </div>
      <div className="mt-3 rounded-[4px] border border-white/[0.14] bg-white/[0.03]">
        <p className="min-h-[4.5rem] px-4 pt-3.5 text-[14px] leading-6 sm:text-[15px]">
          {s.typed > 0 ? (
            <span className="text-(--term-bright)">{TASK.slice(0, s.typed)}</span>
          ) : (
            <span className="text-(--term-dim2)">Describe a task. A agent builds it and opens a pull request.</span>
          )}
          <span className="term-caret ml-px inline-block h-[1.1em] w-px translate-y-[0.2em] bg-(--term-fg)" />
        </p>
        <div className="flex items-center justify-between px-3 pb-3">
          <span className={chip}>
            <span className="size-2 rounded-full bg-(--brand)" /> {CLOUD_RUN.model}
            <ChevronDown className="size-3 text-(--term-dim)" />
          </span>
          <span className={cn("grid size-8 place-items-center rounded-[3px] text-white transition-colors", s.typed >= TASK.length ? "bg-(--brand-fill)" : "bg-white/[0.1]")}>
            <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </span>
        </div>
      </div>
      <p className="mt-3 text-[12px] text-(--term-dim)">Runs in its own worker container. You review the pull request.</p>
    </div>
  )
}

function Run({ s }: { s: Snapshot }) {
  const working = s.sent && !s.pr
  return (
    <div className={cn("col-start-1 row-start-1 transition-opacity duration-300", !s.sent && "invisible opacity-0")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-medium text-(--term-bright) sm:text-[16px]">{CLOUD_RUN.pr.title}</p>
          <p className="mt-1 truncate font-mono text-[11.5px] text-(--term-dim)">
            {CLOUD_RUN.repo} · {CLOUD_RUN.branch} · {CLOUD_RUN.model}
          </p>
        </div>
        <span
          className={cn(
            "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[3px] border px-2 text-[11.5px]",
            s.pr ? "border-good/40 text-good" : "border-warning/40 text-warning",
          )}
        >
          <span className={cn("size-1.5 rounded-full", s.pr ? "bg-good" : "term-pulse bg-warning")} />
          {s.pr ? "PR ready" : "Working"}
        </span>
      </div>

      <ol className="mt-4 space-y-1.5 border-t border-white/[0.08] pt-4 font-mono text-[11.5px] leading-[1.6] sm:text-[12.5px]">
        {CLOUD_RUN.log.map((line, i) => (
          <li key={line.text} className={cn("grid grid-cols-[2ch_minmax(0,1fr)]", i >= s.lines && "invisible")}>
            <span className={line.kind === "tool" || line.kind === "test" ? "text-(--green)" : "text-(--term-dim)"}>{line.kind === "tool" || line.kind === "test" ? "●" : "·"}</span>
            <span className="min-w-0 truncate">
              <span className={line.kind === "tool" || line.kind === "test" ? "text-(--term-bright)" : "text-(--term-fg)"}>{line.text}</span>
              {line.note ? <span className={cn("ml-2", line.kind === "test" ? "text-(--green)" : "text-(--term-dim)")}>{line.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>

      <div className={cn("mt-3 flex h-5 items-center gap-2 text-[12px] text-(--term-dim)", !working && "invisible")}>
        <LoaderCircle className="size-3.5 animate-spin text-(--brand)" />
        {s.step ?? " "}
      </div>

      <div
        className={cn(
          "mt-3 rounded-[4px] border border-white/[0.12] bg-white/[0.03] p-3.5 transition-all duration-500",
          s.pr ? "translate-y-0 opacity-100" : "invisible translate-y-1 opacity-0",
        )}
      >
        <div className="flex items-center gap-2 text-[13px]">
          <GitPullRequest className="size-4 text-good" />
          <span className="font-medium text-(--term-bright)">Pull request #{CLOUD_RUN.pr.number}</span>
          <span className="truncate text-(--term-dim)">into {CLOUD_RUN.base}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px]">
          <span className="text-good">+{CLOUD_RUN.pr.add}</span>
          <span className="text-bad">−{CLOUD_RUN.pr.del}</span>
          <span className="text-(--term-dim)">{CLOUD_RUN.pr.files} files</span>
          <span className="inline-flex items-center gap-1 text-(--term-fg)">
            <Check className="size-3.5 text-good" /> Tests passed
          </span>
        </div>
        <div className="mt-3 flex gap-2">
          <span className="inline-flex h-8 items-center rounded-[3px] border border-white/[0.14] px-3 text-[12.5px]">Review changes</span>
          <span className="inline-flex h-8 items-center rounded-[3px] bg-(--brand-fill) px-3 text-[12.5px] font-medium text-white">Merge</span>
        </div>
      </div>
    </div>
  )
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5 fill-current text-(--term-fg)" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}
