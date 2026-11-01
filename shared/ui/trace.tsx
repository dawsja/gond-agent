import type { ComponentProps, ReactNode } from "react"
import { Collapsible } from "radix-ui"
import { ChevronRight } from "lucide-react"
import { cn } from "../utils"

// shadcn Trace, adapted to Gond's typography, focus treatment and quiet activity rows.
export function Trace({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="trace" className={cn("flex min-w-0 flex-col gap-1", className)} {...props} />
}
export function TraceLine({ className, status, ...props }: ComponentProps<"span"> & { status?: "running" | "error" | "pending" }) {
  return <span data-slot="trace-line" data-status={status} className={cn("flex min-w-0 items-center gap-2 text-xs text-muted-foreground data-[status=running]:text-foreground data-[status=error]:text-failed data-[status=pending]:text-muted-foreground", className)} {...props} />
}
export function TraceIcon({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-icon" aria-hidden="true" className={cn("inline-flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5", className)} {...props} />
}
export function TraceTitle({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-title" className={cn("min-w-0 break-words text-left", className)} {...props} />
}
export function TraceDescription({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="trace-description" className={cn("ml-auto shrink-0 text-[11px] text-subtle tabular-nums", className)} {...props} />
}
export const TraceCollapsible = Collapsible.Root
export function TraceCollapsibleTrigger({ className, children, indicator, ...props }: ComponentProps<typeof Collapsible.Trigger> & { indicator?: ReactNode }) {
  return <Collapsible.Trigger data-slot="trace-trigger" className={cn("group/trace flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", className)} {...props}>
    <TraceIcon>{indicator ?? <ChevronRight className="size-3 text-subtle group-data-[state=open]/trace:rotate-90" />}</TraceIcon>{children}
  </Collapsible.Trigger>
}
export function TraceCollapsibleContent({ className, ...props }: ComponentProps<typeof Collapsible.Content>) {
  return <Collapsible.Content data-slot="trace-content" className={cn("ml-1.5 min-w-0 border-l border-border py-2 pr-1 pl-4", className)} {...props} />
}
