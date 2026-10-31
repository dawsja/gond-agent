import { ChevronDown } from "lucide-react"
import { PickerPopover } from "./picker-popover"
import { pickerChip } from "@/features/studio/theme"
import { cn } from "@/lib/utils"
import type { Model } from "@/lib/api"
export function effortFor(model: Model | undefined, value: string) {
  return model?.efforts?.includes(value) ? value : "default"
}
const effortLabel = (value: string) => value === "default" ? "Default effort" : value.charAt(0).toUpperCase() + value.slice(1)
export function EffortPicker({ model, value, onChange, disabled }: { model?: Model; value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const selected = effortFor(model, value)
  return <PickerPopover value={selected} onSelect={onChange} placeholder="Search thinking levels" width="w-48" items={["default", ...(model?.efforts ?? [])].filter((effort, index, efforts) => efforts.indexOf(effort) === index).map(effort => ({ value: effort, label: effortLabel(effort), search: effortLabel(effort) }))} trigger={<button type="button" aria-label="Reasoning effort" disabled={disabled || !model?.efforts?.length} className={cn(pickerChip, "gap-1.5 px-2.5")}><span>{selected === "default" ? "Default" : effortLabel(selected)}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" /></button>} />
}
