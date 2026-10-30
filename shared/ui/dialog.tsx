import { Dialog as Primitive } from "radix-ui"
import { X } from "lucide-react"
import type { ComponentProps } from "react"
import { cn } from "../utils"
import { Button } from "./button"

export const Dialog = Primitive.Root
export const DialogTitle = Primitive.Title
export const DialogDescription = Primitive.Description
export function DialogContent({ className, children, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Overlay className="fixed inset-0 z-50 bg-black/70" /><Primitive.Content className={cn("fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-md border border-border-strong bg-popover p-5 text-foreground shadow-lg", className)} {...props}>
    {children}<Primitive.Close asChild><Button variant="ghost" size="icon" aria-label="Close" className="absolute top-2 right-2"><X /></Button></Primitive.Close>
  </Primitive.Content></Primitive.Portal>
}
