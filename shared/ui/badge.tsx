import type { ComponentProps } from "react"
import { cn } from "../utils"
export function Badge({ className, variant = "info", ...props }: ComponentProps<"span"> & { variant?: "good" | "warning" | "bad" | "info" | "neutral" }) {
  const colors = { good: "bg-good/10 text-good", warning: "bg-warning/10 text-warning", bad: "bg-bad/10 text-bad", info: "bg-info/10 text-info", neutral: "bg-raised text-muted-foreground" }
  return <span data-slot="badge" className={cn("inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-medium", colors[variant], className)} {...props} />
}
