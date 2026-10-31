import type { ComponentProps } from "react"
import { ToggleGroup as Primitive } from "radix-ui"
import { cn } from "../utils"

export function ToggleGroup({ className, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <Primitive.Root data-slot="toggle-group" className={cn("flex gap-2", className)} {...props} />
}

export function ToggleGroupItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item data-slot="toggle-group-item" className={cn("inline-flex h-12 min-w-0 items-center justify-start gap-3 rounded-md border border-input bg-card px-3 text-sm font-medium text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:border-link/60 data-[state=on]:bg-accent-soft/40 data-[state=on]:text-foreground disabled:pointer-events-none disabled:opacity-50", className)} {...props} />
}
