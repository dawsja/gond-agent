import { Check, Search } from "lucide-react"
import { Popover } from "radix-ui"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { devOpen } from "@/lib/dev-open"
import { cn } from "@/lib/utils"
import { mono } from "@/features/studio/theme"

/**
 * A searchable list in a popover. Free text is accepted when `allowCustom` validates it. The reference for
 * every picker (the composer's repository, branch and model; Gond Agent Runners).
 */
export function PickerPopover({
  trigger,
  items,
  value,
  onSelect,
  placeholder,
  allowCustom,
  empty,
  width = "w-80",
  name,
  align = "start",
  footer,
}: {
  trigger: ReactNode
  /** `group` puts items under headings (in order of first appearance); `search` is extra text to match. */
  items: { value: string; label: ReactNode; hint?: ReactNode; group?: string; search?: string }[]
  value: string | null
  onSelect: (v: string) => void
  placeholder: string
  allowCustom?: (q: string) => boolean
  empty?: ReactNode
  width?: string
  name?: string
  align?: "start" | "end"
  footer?: ReactNode
}) {
  const [open, setOpen] = useState(() => !!name && devOpen(name))
  const [q, setQ] = useState("")
  const needle = q.trim().toLowerCase()
  const matches = items.filter((i) => `${i.value} ${i.search ?? ""} ${i.group ?? ""}`.toLowerCase().includes(needle))
  const shown = matches.slice(0, 50)
  const custom = q.trim() && allowCustom?.(q.trim()) && !items.some((i) => i.value === q.trim()) ? q.trim() : null
  // Opens on the selected item (a long list, like times of day, would otherwise hide it).
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "center" }))
    return () => cancelAnimationFrame(raf)
  }, [open])
  const pick = (v: string) => {
    onSelect(v)
    setOpen(false)
    setQ("")
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align={align}
          sideOffset={6}
          className={cn("z-50 max-w-[calc(100vw-24px)] overflow-hidden rounded-[4px] border border-border-strong bg-popover text-foreground", width)}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  if (custom) pick(custom)
                  else if (shown[0]) pick(shown[0].value)
                }
              }}
              placeholder={placeholder}
              aria-label={placeholder}
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
            />
          </div>
          <ul ref={list} className="max-h-72 overflow-y-auto p-1">
            {custom && (
              <li>
                <button type="button" onClick={() => pick(custom)} className="flex h-8 w-full items-center gap-2 rounded-[3px] px-2 text-left text-[13px] hover:bg-raised">
                  Use <span style={mono}>{custom}</span>
                </button>
              </li>
            )}
            {shown.map((i, n) => (
              <li key={i.value}>
                {i.group && i.group !== shown[n - 1]?.group && (
                  <div className={cn("px-2 pt-2 pb-1 text-[11px] text-subtle", n > 0 && "mt-1 border-t border-border")}>{i.group}</div>
                )}
                <button
                  type="button"
                  data-selected={i.value === value || undefined}
                  onClick={() => pick(i.value)}
                  className="flex h-8 w-full items-center gap-2 rounded-[3px] px-2 text-left text-[13px] hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate">{i.label}</span>
                  {i.hint && <span className="shrink-0 text-[12px] text-muted-foreground">{i.hint}</span>}
                  <Check className={cn("size-3.5 shrink-0 text-foreground", i.value !== value && "invisible")} />
                </button>
              </li>
            ))}
            {!custom && shown.length === 0 && <li className="px-2 py-2 text-[12px] text-muted-foreground">{empty ?? "Nothing matches"}</li>}
            {matches.length > shown.length && <li className="px-2 py-2 text-[12px] text-muted-foreground">Showing {shown.length} of {matches.length}. Search to narrow the list.</li>}
          </ul>
          {footer && <div className="flex items-center justify-between gap-2 border-t border-border p-2">{footer}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
