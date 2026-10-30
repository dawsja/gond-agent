import type { ComponentProps } from "react"
import { Tabs as Primitive } from "radix-ui"
import { cn } from "../utils"
export function Tabs({ className, ...props }: ComponentProps<typeof Primitive.Root>) { return <Primitive.Root data-slot="tabs" className={cn("min-w-0", className)} {...props} /> }
export function TabsList({ className, ...props }: ComponentProps<typeof Primitive.List>) { return <Primitive.List data-slot="tabs-list" className={cn("inline-flex items-center gap-1 rounded-md border border-border bg-card p-1", className)} {...props} /> }
export function TabsTrigger({ className, ...props }: ComponentProps<typeof Primitive.Trigger>) { return <Primitive.Trigger data-slot="tabs-trigger" className={cn("inline-flex items-center justify-center gap-2 rounded-sm px-3 py-1.5 text-sm text-muted-foreground outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-raised data-[state=active]:text-foreground disabled:opacity-50", className)} {...props} /> }
export function TabsContent({ className, ...props }: ComponentProps<typeof Primitive.Content>) { return <Primitive.Content data-slot="tabs-content" className={cn("min-h-0 outline-none", className)} {...props} /> }
