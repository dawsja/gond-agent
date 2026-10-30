import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/lib/api"
import { Button } from "@shared/ui/button"
import { Input, NativeSelect } from "@shared/ui/input"
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from "@shared/ui/field"
import { Section } from "../studio/section"

type Format = "anthropic" | "openai" | "openai-responses"
interface ProviderModel { id: string; name: string; contextWindow: number; maxOutput: number; reasoning: "none" | "adaptive" | "budget" | "effort"; images: boolean }
interface Connection { id: string; name: string; format: Format; baseURL: string; hasKey: boolean; apiKey?: string; clearKey?: boolean; models: ProviderModel[] }
interface Settings { connections: Connection[]; defaultModel: string; transcription: { connectionId: string; model: string } | null }
const modelId = (connection: string, id: string) => `${connection}:${encodeURIComponent(id)}`
const newModel = (id = ""): ProviderModel => ({ id, name: id, contextWindow: 128000, maxOutput: 8192, reasoning: "none", images: false })

export function ProviderSettings({ setup = false }: { setup?: boolean }) {
  const query = useQuery({ queryKey: ["providers"], queryFn: () => api<Settings>("/v1/settings/providers") })
  return <Section title={setup ? "Connect your models" : "Model providers"} description="Use Anthropic Messages, OpenAI-compatible Chat Completions, or OpenAI Responses. Connections are shared by every account on this server.">
    {query.isPending ? <p className="p-5 text-sm">Loading…</p> : query.isError ? <p role="alert" className="p-5 text-sm text-failed">{query.error.message}</p> : <ProviderForm initial={query.data} setup={setup} />}
  </Section>
}

function ProviderForm({ initial, setup }: { initial: Settings; setup: boolean }) {
  const [value, setValue] = useState(initial), [dirty, setDirty] = useState(false), qc = useQueryClient()
  const update = (next: Settings) => { setValue(next); setDirty(true); save.reset(); test.reset() }
  const connection = (id: string, change: Partial<Connection>) => update({ ...value, connections: value.connections.map(c => c.id === id ? { ...c, ...change } : c) })
  const models = value.connections.flatMap(c => c.models.filter(m => m.id.trim()).map(m => ({ id: modelId(c.id, m.id.trim()), name: `${m.name || m.id} · ${c.name}` })))
  const defaultModel = models.some(m => m.id === value.defaultModel) ? value.defaultModel : models[0]?.id ?? ""
  const save = useMutation({
    mutationFn: () => api<Settings>("/v1/settings/providers", { method: "PUT", body: { ...value, defaultModel } }),
    onSuccess: data => {
      setValue(data); setDirty(false); qc.setQueryData(["providers"], data)
      void qc.invalidateQueries({ queryKey: ["models"] }); void qc.invalidateQueries({ queryKey: ["me"] })
    },
  })
  const test = useMutation({ mutationFn: (id: string) => api<{ models: string[] }>("/v1/settings/providers/test", { body: { id } }) })
  const add = () => update({ ...value, connections: [...value.connections, { id: crypto.randomUUID(), name: "My provider", format: "openai", baseURL: "https://api.openai.com/v1", hasKey: false, models: [newModel()] }] })
  const transcriptionConnections = value.connections.filter(c => c.format !== "anthropic")
  return <form onSubmit={e => { e.preventDefault(); save.mutate() }} className="border-t border-border p-5">
    <FieldGroup>
    <p className="text-xs text-muted-foreground">API keys are encrypted on this server and never returned to your browser. Leave a saved key blank to keep it. A key is optional for local APIs that do not require authentication.</p>
    {value.connections.map(c => <FieldSet key={c.id} disabled={save.isPending} className="min-w-0">
      <FieldLegend className="max-w-full truncate px-1 text-sm font-medium">{c.name || "Provider"}</FieldLegend>
      <FieldGroup className="grid sm:grid-cols-2">
        <Field><FieldLabel className="min-w-0 text-sm">Connection name<Input required maxLength={80} value={c.name} onChange={e => connection(c.id, { name: e.target.value })} /></FieldLabel></Field>
        <Field><FieldLabel className="min-w-0 text-sm">API format<NativeSelect aria-label="API format" value={c.format} onChange={e => connection(c.id, { format: e.target.value as Format, models: c.models.map(m => ({ ...m, reasoning: "none" })) })}><option value="openai">OpenAI-compatible Chat Completions</option><option value="anthropic">Anthropic Messages</option><option value="openai-responses">OpenAI Responses</option></NativeSelect></FieldLabel></Field>
      </FieldGroup>
      <Field><FieldLabel className="block text-sm">API base URL<Input required type="url" placeholder="https://api.example.com/v1" value={c.baseURL} onChange={e => connection(c.id, { baseURL: e.target.value })} /></FieldLabel></Field>
      <p className="text-xs text-muted-foreground">Include the API prefix, such as /v1. For a local server, use its address as reachable from the Gond Agent host. Anthropic's default is https://api.anthropic.com/v1.</p>
      <Field><FieldLabel className="block text-sm">API key<Input type="password" autoComplete="new-password" placeholder={c.hasKey ? "Saved — leave blank to keep" : "Optional for unauthenticated local APIs"} value={c.apiKey ?? ""} onChange={e => connection(c.id, { apiKey: e.target.value, clearKey: false })} /></FieldLabel></Field>
      {c.hasKey && <Field><FieldLabel className="flex-row items-center gap-2 text-xs"><input type="checkbox" checked={!!c.clearKey} onChange={e => connection(c.id, { clearKey: e.target.checked, apiKey: "" })} /> Clear saved API key</FieldLabel></Field>}
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">Models</p>
        {c.models.map((m, i) => {
          const change = (patch: Partial<ProviderModel>) => connection(c.id, { models: c.models.map((item, index) => index === i ? { ...item, ...patch } : item) })
          return <div key={i} className="flex flex-col gap-3 border-t border-border pt-3">
            <div className="grid gap-3 sm:grid-cols-2"><Field><FieldLabel className="min-w-0 text-sm">Model ID<Input required maxLength={240} value={m.id} placeholder="Exact model ID from your provider" onChange={e => change({ id: e.target.value, ...(m.name === m.id ? { name: e.target.value } : {}) })} /></FieldLabel></Field><Field><FieldLabel className="min-w-0 text-sm">Display name<Input required maxLength={120} value={m.name} onChange={e => change({ name: e.target.value })} /></FieldLabel></Field></div>
            <details><summary className="cursor-pointer text-xs text-muted-foreground">Model capabilities</summary><div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field><FieldLabel className="text-sm">Context window<Input required type="number" min={1024} max={10000000} value={m.contextWindow} onChange={e => change({ contextWindow: Number(e.target.value) })} /></FieldLabel></Field>
              <Field><FieldLabel className="text-sm">Maximum output tokens<Input required type="number" min={256} max={m.contextWindow} value={m.maxOutput} onChange={e => change({ maxOutput: Number(e.target.value) })} /></FieldLabel></Field>
              <Field><FieldLabel className="text-sm">Reasoning<NativeSelect aria-label="Reasoning" value={m.reasoning} onChange={e => change({ reasoning: e.target.value as ProviderModel["reasoning"] })}><option value="none">Provider default</option>{c.format === "anthropic" ? <><option value="adaptive">Adaptive thinking</option><option value="budget">Budget thinking</option></> : <option value="effort">Reasoning effort</option>}</NativeSelect></FieldLabel></Field>
              <Field><FieldLabel className="flex-row items-center gap-2 text-sm"><input type="checkbox" checked={m.images} onChange={e => change({ images: e.target.checked })} /> Supports images</FieldLabel></Field>
            </div></details>
            <Button type="button" variant="ghost" size="sm" className="self-start text-destructive" onClick={() => connection(c.id, { models: c.models.filter((_, index) => index !== i) })}>Remove model</Button>
          </div>
        })}
        <Button type="button" variant="outline" onClick={() => connection(c.id, { models: [...c.models, newModel()] })}>Add model</Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3"><Button type="button" disabled={dirty || test.isPending || !initial.connections.some(item => item.id === c.id)} variant="outline" onClick={() => test.mutate(c.id)}>Test saved connection</Button><Button type="button" variant="ghost" size="sm" className="self-start text-destructive" onClick={() => update({ ...value, connections: value.connections.filter(item => item.id !== c.id) })}>Remove provider</Button></div>
      {test.variables === c.id && test.isPending && <p role="status" className="text-xs">Connecting…</p>}
      {test.variables === c.id && test.isError && <p role="alert" className="text-sm text-failed">{test.error.message}</p>}
      {test.variables === c.id && test.isSuccess && <div className="flex flex-col gap-2"><p role="status" className="text-xs">Connected. Select a model to add it, or enter its ID manually.</p><div className="flex max-h-36 flex-wrap gap-2 overflow-auto">{test.data.models.map(id => <Button key={id} type="button" variant="outline" size="sm" className="h-auto max-w-full break-all whitespace-normal text-left" disabled={c.models.some(m => m.id === id)} onClick={() => connection(c.id, { models: [...c.models.filter(m => m.id), newModel(id)] })}>{id}</Button>)}</div></div>}
    </FieldSet>)}
    <Button type="button" onClick={add} variant="outline">Add provider</Button>
    <Field><FieldLabel className="block text-sm">Default model<NativeSelect aria-label="Default model" required value={defaultModel} onChange={e => update({ ...value, defaultModel: e.target.value })}><option value="" disabled>Choose a model</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</NativeSelect></FieldLabel></Field>
    <div className="flex flex-col gap-3 border-t border-border pt-4"><h3 className="text-sm font-medium">Voice transcription (optional)</h3><p className="text-xs text-muted-foreground">Uses the selected connection's API URL and key. The server must support audio/transcriptions.</p>
      <Field><FieldLabel className="block text-sm">Transcription provider<NativeSelect aria-label="Transcription provider" value={value.transcription?.connectionId ?? ""} onChange={e => update({ ...value, transcription: e.target.value ? { connectionId: e.target.value, model: value.transcription?.model ?? "whisper-1" } : null })}><option value="">Disabled</option>{transcriptionConnections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</NativeSelect></FieldLabel></Field>
      {value.transcription && <Field><FieldLabel className="block text-sm">Transcription model ID<Input required value={value.transcription.model} onChange={e => update({ ...value, transcription: { ...value.transcription!, model: e.target.value } })} /></FieldLabel></Field>}
    </div>
    {save.isError && <p role="alert" className="text-sm text-failed">{save.error.message}</p>}
    {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Provider settings saved.</p>}
    <p className="text-xs text-muted-foreground">Save before testing a connection. Model IDs and capabilities must match your provider. Token usage is recorded; provider billing remains with your provider.</p>
    <Button disabled={save.isPending || !models.length} type="submit">{save.isPending ? "Saving…" : setup ? "Finish setup" : "Save provider settings"}</Button>
    </FieldGroup>
  </form>
}
