import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import type { Model } from "@/lib/api"
import { cn } from "@/lib/utils"
import { ModelMark, providerOf, PROVIDER_LABEL, shortModel } from "@/features/studio/parts"
import { pickerChip } from "@/features/studio/theme"
import { PickerPopover } from "./picker-popover"

export function ModelPicker({ models, value, onChange, label = "Choose model", loading, disabled, footer }: {
  models: Model[]; value: string; onChange: (value: string) => void; label?: string; loading?: boolean; disabled?: boolean; footer?: ReactNode
}) {
  const selected = models.find(model => model.id === value)
  return <PickerPopover name="model" value={value} onSelect={onChange} width="w-72" placeholder="Search models" empty={loading ? "Loading models…" : "No models available. Check your connections in Settings."} footer={footer} items={models.map(model => ({
    value: model.id,
    label: <span title={model.resolved_model ?? model.display_name} className="flex min-w-0 items-center gap-2"><ModelMark id={model.id} provider={model.provider} size={15} /><span className="truncate">{model.display_name}</span></span>,
    group: model.provider === "auto" ? "Automatic" : model.connection_name ?? PROVIDER_LABEL[providerOf(model.id)] ?? model.provider,
    search: [model.display_name, model.resolved_model, model.id].filter(Boolean).join(" "),
  }))} trigger={<button type="button" aria-label={label} title={selected?.resolved_model ?? selected?.display_name} disabled={disabled} className={cn(pickerChip, "max-w-[240px] shrink gap-1.5 px-2.5")}>
    {(selected || value) && <ModelMark id={value} provider={selected?.provider} size={15} />}
    <span className="min-w-0 truncate">{selected ? shortModel(selected.display_name, selected.id) : (value || (loading ? "Loading models…" : "No models available"))}</span>
    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </button>} />
}
