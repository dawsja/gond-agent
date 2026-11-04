import { Check, ChevronDown } from "lucide-react"
import { Select as Primitive } from "radix-ui"
import type { ComponentProps } from "react"
import { cn } from "../utils"

export const Select = Primitive.Root
export const SelectValue = Primitive.Value

export function SelectTrigger({ className, children, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger className={cn("flex h-10 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0", className)} {...props}>{children}<Primitive.Icon asChild><ChevronDown className="text-muted-foreground" /></Primitive.Icon></Primitive.Trigger>
}

export function SelectContent({ className, children, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Content position="popper" sideOffset={6} className={cn("z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border-strong bg-popover p-1 text-foreground shadow-subtle-3", className)} {...props}><Primitive.Viewport>{children}</Primitive.Viewport></Primitive.Content></Primitive.Portal>
}

export function SelectItem({ className, children, ...props }: ComponentProps<typeof Primitive.Item>) {
  return <Primitive.Item className={cn("relative flex h-8 cursor-default select-none items-center rounded-sm px-2 pr-8 text-[13px] outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0", className)} {...props}><Primitive.ItemText><span className="flex items-center gap-2">{children}</span></Primitive.ItemText><Primitive.ItemIndicator className="absolute right-2"><Check className="size-3.5" /></Primitive.ItemIndicator></Primitive.Item>
}
