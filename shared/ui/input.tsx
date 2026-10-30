import type { ComponentProps } from "react"
import { cn } from "../utils"
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input data-slot="input" className={cn("h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-invalid:border-destructive", className)} {...props} />
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn("min-h-24 w-full min-w-0 resize-none rounded-md border border-input bg-card p-3 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", className)} {...props} />
}
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select data-slot="native-select" className={cn("h-10 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50", className)} {...props} />
}
