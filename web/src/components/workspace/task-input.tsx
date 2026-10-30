import { type ReactNode, type Ref, useImperativeHandle, useState } from "react"
import { ArrowUp } from "lucide-react"
import { Button } from "@shared/ui/button"
import { Textarea } from "@shared/ui/input"
import { cn } from "@/lib/utils"

export function TaskInput({ inputRef, defaultValue = "", placeholder, disabled, busy, footer, children, onSubmit, className }: {
  inputRef?: Ref<{ insertText: (text: string) => void }>; defaultValue?: string; placeholder: string; disabled?: boolean; busy?: boolean; footer?: ReactNode; children?: ReactNode; onSubmit: (text: string) => void; className?: string
}) {
  const [text, setText] = useState(defaultValue)
  useImperativeHandle(inputRef, () => ({ insertText: chunk => setText(text => text + (text && !/\s$/.test(text) ? " " : "") + chunk) }), [])
  const send = () => { if (!disabled && !busy && text.trim()) onSubmit(text.trim()) }
  return <form aria-label="New agent task" onSubmit={e => { e.preventDefault(); send() }} className={cn("overflow-hidden rounded-md border border-input bg-card focus-within:border-primary", className)}>
    {children}<Textarea aria-label="Task prompt" rows={4} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} placeholder={placeholder} disabled={disabled || busy} className="border-0 px-5 pt-4 text-base focus-visible:ring-0" />
    <div className="flex flex-wrap items-center gap-2 px-3 pb-3">{footer}<Button type="submit" size="icon" className="ml-auto" aria-label="Start agent" disabled={disabled || busy || !text.trim()}><ArrowUp /></Button></div>
  </form>
}
export function FollowUpInput({ value, onValueChange, leading, placeholder, disabled, attached, onSubmit }: {
  value: string; onValueChange: (text: string) => void; leading?: ReactNode; placeholder: string; disabled?: boolean; attached: number; onSubmit: (text: string) => void
}) {
  const send = () => { if (!disabled && (value.trim() || attached)) { onSubmit(value.trim()) } }
  return <form aria-label="Agent follow-up" onSubmit={e => { e.preventDefault(); send() }} className="flex flex-col gap-2 rounded-md border border-input bg-card p-3 focus-within:border-primary">
    <Textarea rows={2} aria-label="Follow-up message" value={value} onChange={e => onValueChange(e.target.value)} placeholder={placeholder} disabled={disabled} className="min-h-16 border-0 focus-visible:ring-0" onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
    <div className="flex items-center gap-2">{leading}<Button type="submit" size="icon" className="ml-auto" aria-label="Send message" disabled={disabled || (!value.trim() && !attached)}><ArrowUp /></Button></div>
  </form>
}
