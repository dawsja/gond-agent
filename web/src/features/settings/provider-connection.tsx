import { useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import { changeFormat, DEFAULT_URLS, newModel, type Connection, type Format, type ProviderModel } from "@/lib/provider-settings"
import { Button } from "@shared/ui/button"
import { Input, NativeSelect } from "@shared/ui/input"
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@shared/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@shared/ui/toggle-group"
import { Switch } from "@shared/ui/switch"
import { ModelMark } from "../studio/parts"

const providerName = (format: Format) => format === "anthropic" ? "Anthropic" : "OpenAI"
const endpoint = (url: string) => url.trim().replace(/\/+$/, "")

export function ProviderConnection({ value: c, saved, multiple, onChange, onRemove, disabled }: { value: Connection; saved?: Connection; multiple: boolean; onChange: (change: Partial<Connection>) => void; onRemove: () => void; disabled: boolean }) {
  const [editingURL, setEditingURL] = useState(false)
  const urlInput = useRef<HTMLInputElement>(null)
  const changedAPI = !!saved && (saved.format !== c.format || endpoint(saved.baseURL) !== endpoint(c.baseURL))
  const needsKey = c.hasKey && changedAPI && !c.clearKey
  const format = (next: Format) => onChange({ ...changeFormat(c, next), ...(!saved && c.name === providerName(c.format) ? { name: providerName(next) } : {}) })
  const editURL = () => { if (!editingURL || urlInput.current?.reportValidity()) setEditingURL(!editingURL) }

  return <FieldSet disabled={disabled} className="gap-6 rounded-none border-0 p-0">
    <FieldLegend className={multiple ? "mb-4 max-w-full truncate px-0 text-sm font-medium" : "sr-only"}>{c.name || providerName(c.format)}</FieldLegend>
    <Field>
      <p id={`${c.id}-provider`} className="text-sm font-medium">Provider</p>
      <ToggleGroup type="single" aria-labelledby={`${c.id}-provider`} value={c.format === "anthropic" ? "anthropic" : "openai"} disabled={disabled} onValueChange={value => { if (value && value !== (c.format === "anthropic" ? "anthropic" : "openai")) format(value as Format) }} className="grid grid-cols-2">
        <ToggleGroupItem value="openai"><ModelMark id="gpt" size={20} />OpenAI</ToggleGroupItem>
        <ToggleGroupItem value="anthropic"><ModelMark id="claude" size={20} />Anthropic</ToggleGroupItem>
      </ToggleGroup>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 break-all text-xs text-muted-foreground">{c.baseURL || DEFAULT_URLS[c.format]}</span>
        <Button variant="link" size="sm" className="h-auto px-0 text-xs text-muted-foreground" aria-expanded={editingURL} aria-controls={`${c.id}-url-field`} onClick={editURL}>{editingURL ? "Done" : "Edit URL"}</Button>
      </div>
      {editingURL && <Field id={`${c.id}-url-field`}><FieldLabel htmlFor={`${c.id}-url`} className="text-sm">API base URL</FieldLabel><Input ref={urlInput} id={`${c.id}-url`} required type="url" maxLength={2048} placeholder={DEFAULT_URLS[c.format]} value={c.baseURL} onChange={e => onChange({ baseURL: e.target.value, apiKey: "" })} /><p className="text-xs text-muted-foreground">Include the API prefix, such as /v1.</p></Field>}
    </Field>
    <Field className="border-t border-border pt-6">
      <div className="flex items-center justify-between gap-3"><FieldLabel htmlFor={`${c.id}-key`} className="text-sm">API key</FieldLabel>{c.hasKey && !c.clearKey && <Button variant="link" size="sm" className="h-auto px-0 text-xs text-destructive" onClick={() => onChange({ clearKey: true, apiKey: "" })}>Clear key</Button>}</div>
      <Input id={`${c.id}-key`} type="password" autoComplete="new-password" required={needsKey} placeholder={needsKey ? "Re-enter your key for this API" : c.hasKey && !c.clearKey ? "Saved — paste a new key to replace" : "Paste your API key"} value={c.apiKey ?? ""} onChange={e => onChange({ apiKey: e.target.value, clearKey: false })} />
      {c.clearKey ? <div role="status" className="flex items-center justify-between gap-3 text-xs"><p className="text-warning">Key will be cleared when you save.</p><Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => onChange({ clearKey: false })}>Undo</Button></div> : needsKey && <p className="text-xs text-muted-foreground">The API changed. Enter a key or choose Clear key.</p>}
    </Field>
    <details className="border-t border-border pt-4">
      <summary className="flex cursor-pointer list-none items-center justify-between text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">Advanced settings<ChevronDown className="size-3.5" /></summary>
      <FieldGroup className="mt-3">
        <Field><FieldLabel className="text-sm">Connection name<Input maxLength={80} placeholder={providerName(c.format)} value={c.name} onChange={e => onChange({ name: e.target.value })} /></FieldLabel></Field>
        {c.format !== "anthropic" && <Field><FieldLabel className="text-sm">OpenAI API protocol<NativeSelect aria-label="OpenAI API protocol" value={c.format} onChange={e => onChange(changeFormat(c, e.target.value as Format))}><option value="openai">Chat Completions (default)</option><option value="openai-responses">Responses</option></NativeSelect></FieldLabel><p className="text-xs text-muted-foreground">Choose Responses if your provider requires it.</p></Field>}
        <Field className="flex-row items-center justify-between"><FieldLabel htmlFor={`${c.id}-discover`} className="text-sm">Discover models automatically</FieldLabel><Switch id={`${c.id}-discover`} checked={c.discover} disabled={disabled} onCheckedChange={checked => onChange({ discover: checked })} /></Field>
        <p className="text-xs text-muted-foreground">A key is optional for local APIs that do not require one.</p>
        <p className="text-xs text-muted-foreground">Models appear in the agent's model picker. Add manual IDs only if this endpoint cannot list models, or to override a model's capabilities.</p>
        {c.models.map((m, i) => {
          const change = (patch: Partial<ProviderModel>) => onChange({ models: c.models.map((item, index) => index === i ? { ...item, ...patch } : item) })
          return <FieldGroup key={i} className="border-t border-border pt-3">
            <FieldGroup className="grid sm:grid-cols-2"><Field><FieldLabel className="min-w-0 text-sm">Model ID<Input required maxLength={240} value={m.id} placeholder="Exact model ID from your provider" onChange={e => change({ id: e.target.value, ...(m.name === m.id ? { name: e.target.value.slice(0, 120) } : {}) })} /></FieldLabel></Field><Field><FieldLabel className="min-w-0 text-sm">Display name<Input required maxLength={120} value={m.name} onChange={e => change({ name: e.target.value })} /></FieldLabel></Field></FieldGroup>
            <FieldGroup className="grid sm:grid-cols-2">
              <Field><FieldLabel className="text-sm">Context window<Input required type="number" min={1024} max={10000000} value={m.contextWindow} onChange={e => change({ contextWindow: Number(e.target.value) })} /></FieldLabel></Field>
              <Field><FieldLabel className="text-sm">Maximum output tokens<Input required type="number" min={256} max={m.contextWindow} value={m.maxOutput} onChange={e => change({ maxOutput: Number(e.target.value) })} /></FieldLabel></Field>
              <Field><FieldLabel className="text-sm">Reasoning<NativeSelect aria-label="Reasoning" value={m.reasoning} onChange={e => change({ reasoning: e.target.value as ProviderModel["reasoning"] })}><option value="none">Provider default</option>{c.format === "anthropic" ? <><option value="adaptive">Adaptive thinking</option><option value="budget">Budget thinking</option></> : <option value="effort">Reasoning effort</option>}</NativeSelect></FieldLabel></Field>
              <Field><FieldLabel>Supported efforts<Input value={m.efforts?.join(", ") ?? ""} placeholder="Provider defaults" onChange={e => change({ efforts: e.target.value ? e.target.value.split(",").map(v => v.trim()).filter(Boolean) : undefined })} /></FieldLabel></Field>
              <Field className="flex-row items-center justify-between"><FieldLabel htmlFor={`${c.id}-images-${i}`} className="text-sm">Supports images</FieldLabel><Switch id={`${c.id}-images-${i}`} checked={m.images} disabled={disabled} onCheckedChange={checked => change({ images: checked })} /></Field>
            </FieldGroup>
            <Button type="button" variant="ghost" size="sm" className="self-start text-destructive" onClick={() => onChange({ models: c.models.filter((_, index) => index !== i) })}>Remove model</Button>
          </FieldGroup>
        })}
        <Button type="button" variant="outline" onClick={() => onChange({ models: [...c.models, newModel()] })}>Add manual model</Button>
        <Button type="button" variant="link" size="sm" className="h-auto self-start px-0 text-xs text-destructive" onClick={onRemove}>Remove provider</Button>
      </FieldGroup>
    </details>
  </FieldSet>
}
