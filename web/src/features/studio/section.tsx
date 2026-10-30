import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { T } from "./theme"
import { Card, CardHeader, CardTitle, CardDescription } from "@shared/ui/card"

/** A bordered card with a title, a line of description and an optional action on the right. */
export function Section({
  title,
  description,
  children,
  action,
  icon,
  actionBeside,
}: {
  title: string
  description: string
  children?: ReactNode
  action?: ReactNode
  icon?: ReactNode
  /** Keep the action to the right on phones too (a small control like a switch), instead of below. */
  actionBeside?: boolean
}) {
  return (
    <Card>
      <CardHeader className={cn("flex-row items-start justify-between gap-4 px-5 pt-4 pb-3 max-md:px-4", !actionBeside && "max-md:flex-col max-md:gap-3")}>
        <div className="flex items-start gap-3">
          {icon}
          <div>
            <CardTitle className={cn(T.title, "text-foreground")}>{title}</CardTitle>
            <CardDescription className="max-w-[60ch]">{description}</CardDescription>
          </div>
        </div>
        {action}
      </CardHeader>
      {children}
    </Card>
  )
}

/** A label and its value, on one line. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-3 text-[13px] max-md:px-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-foreground">{children}</span>
    </div>
  )
}
