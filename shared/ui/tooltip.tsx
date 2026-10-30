import { Tooltip as Primitive } from "radix-ui"
import type { ComponentProps } from "react"
import { cn } from "../utils"

export const TooltipProvider = Primitive.Provider
export const Tooltip = Primitive.Root
export const TooltipTrigger = Primitive.Trigger
export function TooltipContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Content sideOffset={sideOffset} className={cn("z-50 rounded-md border border-border-strong bg-popover px-3 py-1.5 text-xs text-foreground shadow-md", className)} {...props} /></Primitive.Portal>
}
