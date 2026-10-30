import type { ComponentProps } from "react"
import { cn } from "../utils"
export function FieldGroup({ className, ...props }: ComponentProps<"div">) { return <div data-slot="field-group" className={cn("flex min-w-0 flex-col gap-4", className)} {...props} /> }
export function Field({ className, ...props }: ComponentProps<"div">) { return <div data-slot="field" className={cn("flex min-w-0 flex-col gap-2 data-[invalid=true]:text-destructive", className)} {...props} /> }
export function FieldLabel({ className, ...props }: ComponentProps<"label">) { return <label data-slot="field-label" className={cn("flex min-w-0 flex-col gap-2 text-sm font-medium", className)} {...props} /> }
export function FieldDescription({ className, ...props }: ComponentProps<"p">) { return <p data-slot="field-description" className={cn("text-xs leading-5 text-muted-foreground", className)} {...props} /> }
export function FieldSet({ className, ...props }: ComponentProps<"fieldset">) { return <fieldset data-slot="field-set" className={cn("flex min-w-0 flex-col gap-4 rounded-md border border-border p-4", className)} {...props} /> }
export function FieldLegend({ className, ...props }: ComponentProps<"legend">) { return <legend data-slot="field-legend" className={cn("px-1 text-sm font-medium", className)} {...props} /> }
