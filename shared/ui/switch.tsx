import type { ComponentProps } from "react"
import { Switch as Primitive } from "radix-ui"
import { cn } from "../utils"

type SwitchProps = ComponentProps<typeof Primitive.Root> & { pending?: boolean }

export function Switch({ className, disabled, pending = false, ...props }: SwitchProps) {
  return <>
    <Primitive.Root data-slot="switch" className={cn("inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-input bg-muted outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:pointer-events-none disabled:opacity-50", className)} {...props} disabled={disabled || pending} aria-busy={pending}>
      <Primitive.Thumb className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-muted-foreground transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-primary-foreground" />
    </Primitive.Root>
    <span role="status" className="sr-only">{pending ? "Saving…" : ""}</span>
  </>
}
