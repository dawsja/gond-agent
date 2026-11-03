import { CheckCircle2, ChevronDown, Circle, CircleDot } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"
import type { PlanStep } from "./transcript"

export function TasksPanel({ steps }: { steps: PlanStep[] }) {
  const [expanded, setExpanded] = useState(false)
  if (!steps.length) return null
  const done = steps.filter(step => step.status === "done").length
  const current = steps.find(step => step.status === "in_progress")
  return (
    <aside aria-label="Tasks" className="sticky top-0 z-20 shrink-0 border-b border-border bg-surface px-5 py-3 max-md:px-3 max-md:py-2">
      <div className="flex items-center gap-3 text-[13px]">
        <h2 className="font-medium">Tasks</h2>
        <span className="text-muted-foreground" aria-live="polite">{done} of {steps.length} done</span>
        <button type="button" aria-label="Expand tasks" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="ml-auto hidden items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-raised max-md:flex">
          <ChevronDown className={cn("size-4 transition-transform", expanded && "rotate-180")} />
        </button>
      </div>
      {current && !expanded && <p className="mt-1 hidden truncate text-[12px] text-accent-foreground max-md:block">{current.text}</p>}
      <ol className={cn("mt-2 max-h-[28vh] space-y-1 overflow-y-auto text-[13px]", !expanded && "max-md:hidden")}>
        {steps.map((step, index) => {
          const Icon = step.status === "done" ? CheckCircle2 : step.status === "in_progress" ? CircleDot : Circle
          return <li key={index} aria-current={step.status === "in_progress" ? "step" : undefined} className={cn("flex items-start gap-2 rounded px-2 py-1", step.status === "in_progress" ? "bg-accent-soft text-foreground" : "text-muted-foreground")}>
            <Icon aria-label={step.status.replace("_", " ")} className={cn("mt-0.5 size-3.5 shrink-0", step.status === "done" && "text-good")} />
            <span className="min-w-0 break-words">{step.text}</span>
          </li>
        })}
      </ol>
    </aside>
  )
}
