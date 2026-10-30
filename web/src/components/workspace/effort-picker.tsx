import { NativeSelect } from "@shared/ui/input"
import type { Model } from "@/lib/api"
export function effortFor(model: Model | undefined, value: string) {
  return model?.efforts?.includes(value) ? value : "default"
}
export function EffortPicker({ model, value, onChange }: { model?: Model; value: string; onChange: (value: string) => void }) {
  return <NativeSelect aria-label="Reasoning effort" value={effortFor(model, value)} onChange={e => onChange(e.target.value)} disabled={!model?.efforts?.length} className="w-auto"><option value="default">Default effort</option>{model?.efforts?.map(e => <option key={e} value={e}>{e === "off" ? "Off" : e.charAt(0).toUpperCase() + e.slice(1)}</option>)}</NativeSelect>
}
