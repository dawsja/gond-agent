import type { ComponentProps } from "react"
import { cn } from "../utils"
export function Card({ className, ...props }: ComponentProps<"section">) { return <section data-slot="card" className={cn("flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card text-card-foreground", className)} {...props} /> }
export function CardHeader({ className, ...props }: ComponentProps<"header">) { return <header data-slot="card-header" className={cn("flex flex-col gap-2 p-5", className)} {...props} /> }
export function CardTitle({ as: Tag = "h2", className, ...props }: ComponentProps<"h2"> & { as?: "h2" | "h3" }) { return <Tag data-slot="card-title" className={cn("text-sm font-semibold", className)} {...props} /> }
export function CardDescription({ className, ...props }: ComponentProps<"p">) { return <p data-slot="card-description" className={cn("text-sm leading-6 text-muted-foreground", className)} {...props} /> }
export function CardContent({ className, ...props }: ComponentProps<"div">) { return <div data-slot="card-content" className={cn("min-w-0 p-5", className)} {...props} /> }
export function CardFooter({ className, ...props }: ComponentProps<"footer">) { return <footer data-slot="card-footer" className={cn("flex items-center gap-3 border-t border-border p-5", className)} {...props} /> }
