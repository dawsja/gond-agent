import { LoaderCircle, Mic, Square } from "lucide-react"
import type { DictationState } from "./dictation"
import { mono } from "./theme"
import { cn } from "./utils"

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`

/** Voice input: click to talk, click again to turn it into text. `compact`: sized for a compact composer's
 *  composer chips (26px) instead of the web composer's 36px buttons. */
export function MicButton({
  state,
  seconds,
  onToggle,
  disabled,
  compact,
  className,
}: {
  state: DictationState
  seconds: number
  onToggle: () => void
  disabled?: boolean
  compact?: boolean
  className?: string
}) {
  const recording = state === "recording"

  if (recording) {
    return (
      <button
        type="button"
        onClick={onToggle}
        aria-label="Stop and turn into text"
        title="Stop and turn into text"
        className={cn(
          "inline-flex shrink-0 items-center gap-2 rounded-[4px] border border-failed/40 bg-failed/10 pl-2 text-[12px] text-foreground transition-colors hover:bg-failed/20",
          compact ? "h-[26px] pr-2" : "h-9 pr-2.5",
          className,
        )}
      >
        <span className="relative grid size-2 place-items-center">
          <span className="absolute size-2 animate-ping rounded-full bg-failed/70 motion-reduce:animate-none" />
          <span className="size-2 rounded-full bg-failed" />
        </span>
        <span className="tabular-nums" style={mono}>
          {clock(seconds)}
        </span>
        <Square className="size-3 fill-current text-muted-foreground" />
      </button>
    )
  }
  const busy = state === "starting" || state === "transcribing"
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || busy}
      aria-label={state === "transcribing" ? "Turning your voice into text" : "Voice input"}
      title={state === "transcribing" ? "Turning your voice into text…" : "Voice input"}
      className={cn(
        "grid shrink-0 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none",
        compact ? "h-[26px] w-[30px] border border-border bg-background" : "size-9 hover:bg-raised",
        !busy && "disabled:opacity-40",
        className,
      )}
    >
      {busy ? <LoaderCircle className={cn("animate-spin", compact ? "size-3.5" : "size-[18px]")} /> : <Mic className={compact ? "size-3.5" : "size-[18px]"} />}
    </button>
  )
}
