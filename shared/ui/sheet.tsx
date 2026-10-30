import type { ComponentProps } from "react"
import { Dialog } from "radix-ui"
import { X } from "lucide-react"
import { cn } from "../utils"
import { Button } from "./button"
export const Sheet = Dialog.Root
export const SheetTrigger = Dialog.Trigger
export const SheetClose = Dialog.Close
export const SheetTitle = Dialog.Title
export const SheetDescription = Dialog.Description
export function SheetContent({ className, children, ...props }: ComponentProps<typeof Dialog.Content>) {
  return <Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-background/80" /><Dialog.Content data-slot="sheet-content" className={cn("fixed inset-y-0 left-0 z-50 flex w-[min(20rem,90vw)] flex-col border-r border-border bg-sidebar p-4 text-foreground outline-none", className)} {...props}>{children}<Dialog.Close asChild><Button variant="ghost" size="icon" className="absolute top-3 right-3" aria-label="Close navigation"><X /></Button></Dialog.Close></Dialog.Content></Dialog.Portal>
}
