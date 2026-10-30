import { Separator as Primitive } from "radix-ui"
import type { ComponentProps } from "react"
import { cn } from "../utils"
export function Separator({ className, orientation = "horizontal", ...props }: ComponentProps<typeof Primitive.Root>) { return <Primitive.Root orientation={orientation} decorative className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)} {...props} /> }
