import type { ComponentProps } from "react"
import { Slot } from "radix-ui"
import { cn } from "../utils"

type Variant = "default" | "outline" | "ghost" | "link" | "destructive"
export interface ButtonProps extends ComponentProps<"button"> { variant?: Variant; size?: "default" | "sm" | "icon"; asChild?: boolean }
const variants: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/85",
  outline: "border border-input bg-card text-foreground hover:bg-accent",
  ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
  link: "text-link underline-offset-4 hover:underline",
  destructive: "bg-destructive text-primary-foreground hover:bg-destructive/85",
}
export function Button({ className, variant = "default", size = "default", asChild, type = "button", ...props }: ButtonProps) {
  const Component = asChild ? Slot.Root : "button"
  return <Component data-slot="button" type={asChild ? undefined : type} className={cn("inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4", size === "icon" ? "size-9" : size === "sm" ? "h-8 px-3" : "h-10 px-4", variants[variant], className)} {...props} />
}
