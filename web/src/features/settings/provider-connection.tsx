import { changeFormat, DEFAULT_URLS, newModel, type Connection, type Format, type ProviderModel } from "@/lib/provider-settings"
import { Button } from "@shared/ui/button"
import { Input, NativeSelect } from "@shared/ui/input"
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@shared/ui/field"

export function ProviderConnection({ value: c, onChange, onRemove, disabled }: { value: Connection; onChange: (change: Partial<Connection>) => void; onRemove: () => void; disabled: boolean }) {
  return <FieldSet disabled={disabled} className="min-w-0">
    <FieldLegend className="max-w-full truncate px-1 text-sm font-medium">{c.name || "Provider"}</FieldLegend>
    <FieldGroup className="grid sm:grid-cols-2">
      <Field><FieldLabel className="min-w-0 text-sm">Connection name<Input required maxLength={80} value={c.name} onChange={e => onChange({ name: e.target.value })} /></FieldLabel></Field>
      <Field><FieldLabel className="min-w-0 text-sm">API format<NativeSelect aria-label="API format" value={c.format} onChange={e => onChange(changeFormat(c, e.target.value as Format))}><option value="openai">OpenAI-compatible Chat Completions</option><option value="anthropic">Anthropic Messages</option><option value="openai-responses">OpenAI Responses</option></NativeSelect></FieldLabel></Field>
    </FieldGroup>
    <Field><FieldLabel className="block text-sm">API base URL<Input required type="url" placeholder={DEFAULT_URLS[c.format]} value={c.baseURL} onChange={e => onChange({ baseURL: e.target.value, apiKey: "", clearKey: false })} /></FieldLabel></Field>
    <p className="text-xs text-muted-foreground">Include the API prefix, such as /v1. Custom URLs are kept when changing formats. Use an address reachable from this server.</p>
    <Field><FieldLabel className="block text-sm">API key<Input type="password" autoComplete="new-password" placeholder={c.hasKey ? "Saved — leave blank to keep" : "Optional for unauthenticated local APIs"} value={c.apiKey ?? ""} onChange={e => onChange({ apiKey: e.target.value, clearKey: false })} /></FieldLabel></Field>
    {c.hasKey && <Field><FieldLabel className="flex-row items-center gap-2 text-xs"><input type="checkbox" checked={!!c.clearKey} onChange={e => onChange({ clearKey: e.target.checked, apiKey: "" })} /> Clear saved API key</FieldLabel></Field>}
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">Advanced model overrides (optional)</summary>
      <FieldGroup className="mt-3">
        <Field><FieldLabel className="flex-row items-center gap-2 text-sm"><input type="checkbox" checked={c.discover} onChange={e => onChange({ discover: e.target.checked })} /> Discover available models automatically</FieldLabel></Field>
        <p className="text-xs text-muted-foreground">Models appear in the agent's model picker. Add manual IDs only if this endpoint cannot list models, or to override a model's capabilities.</p>
        {c.models.map((m, i) => {
          const change = (patch: Partial<ProviderModel>) => onChange({ models: c.models.map((item, index) => index === i ? { ...item, ...patch } : item) })
          return <FieldGroup key={i} className="border-t border-border pt-3">
            <FieldGroup className="grid sm:grid-cols-2"><Field><FieldLabel className="min-w-0 text-sm">Model ID<Input required maxLength={240} value={m.id} placeholder="Exact model ID from your provider" onChange={e => change({ id: e.target.value, ...(m.name === m.id ? { name: e.target.value.slice(0, 120) } : {}) })} /></FieldLabel></Field><Field><FieldLabel className="min-w-0 text-sm">Display name<Input required maxLength={120} value={m.name} onChange={e => change({ name: e.target.value })} /></FieldLabel></Field></FieldGroup>
            <FieldGroup className="grid sm:grid-cols-2">
              <Field><FieldLabel className="text-sm">Context window<Input required type="number" min={1024} max={10000000} value={m.contextWindow} onChange={e => change({ contextWindow: Number(e.target.value) })} /></FieldLabel></Field>
              <Field><FieldLabel className="text-sm">Maximum output tokens<Input required type="number" min={256} max={m.contextWindow} value={m.maxOutput} onChange={e => change({ maxOutput: Number(e.target.value) })} /></FieldLabel></Field>
              <Field><FieldLabel className="text-sm">Reasoning<NativeSelect aria-label="Reasoning" value={m.reasoning} onChange={e => change({ reasoning: e.target.value as ProviderModel["reasoning"] })}><option value="none">Provider default</option>{c.format === "anthropic" ? <><option value="adaptive">Adaptive thinking</option><option value="budget">Budget thinking</option></> : <option value="effort">Reasoning effort</option>}</NativeSelect></FieldLabel></Field>
              <Field><FieldLabel className="flex-row items-center gap-2 text-sm"><input type="checkbox" checked={m.images} onChange={e => change({ images: e.target.checked })} /> Supports images</FieldLabel></Field>
            </FieldGroup>
            <Button type="button" variant="ghost" size="sm" className="self-start text-destructive" onClick={() => onChange({ models: c.models.filter((_, index) => index !== i) })}>Remove model</Button>
          </FieldGroup>
        })}
        <Button type="button" variant="outline" onClick={() => onChange({ models: [...c.models, newModel()] })}>Add manual model</Button>
      </FieldGroup>
    </details>
    <Button type="button" variant="ghost" size="sm" className="self-start text-destructive" onClick={onRemove}>Remove provider</Button>
  </FieldSet>
}
