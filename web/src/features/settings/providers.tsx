import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/lib/api"
import { randomId } from "@/lib/id"
import { DEFAULT_URLS, type Connection, type ProviderSettingsValue } from "@/lib/provider-settings"
import { Button } from "@shared/ui/button"
import { FieldGroup } from "@shared/ui/field"
import { Section } from "../studio/section"
import { ProviderConnection } from "./provider-connection"

export function ProviderSettings({ setup = false }: { setup?: boolean }) {
  const query = useQuery({ queryKey: ["providers"], queryFn: () => api<ProviderSettingsValue>("/v1/settings/providers") })
  return <Section title={setup ? "Connect your models" : "Model providers"} description="Use Anthropic Messages, OpenAI-compatible Chat Completions, or OpenAI Responses. Connections are shared by every account on this server.">
    {query.isPending ? <p className="p-5 text-sm">Loading…</p> : query.isError ? <p role="alert" className="p-5 text-sm text-failed">{query.error.message}</p> : <ProviderForm initial={query.data} setup={setup} />}
  </Section>
}

function ProviderForm({ initial, setup }: { initial: ProviderSettingsValue; setup: boolean }) {
  const [value, setValue] = useState(initial), qc = useQueryClient()
  const update = (next: ProviderSettingsValue) => { setValue(next); save.reset() }
  const connection = (id: string, change: Partial<Connection>) => update({ ...value, connections: value.connections.map(c => c.id === id ? { ...c, ...change } : c) })
  const save = useMutation({
    mutationFn: () => api<ProviderSettingsValue>("/v1/settings/providers", { method: "PUT", body: { ...value, defaultModel: value.connections.some(c => value.defaultModel.startsWith(c.id + ":")) ? value.defaultModel : "" } }),
    onSuccess: data => {
      setValue(data); qc.setQueryData(["providers"], data)
      void qc.invalidateQueries({ queryKey: ["models"] }); void qc.invalidateQueries({ queryKey: ["me"] })
    },
  })
  const add = () => update({ ...value, connections: [...value.connections, { id: randomId(), name: `Provider ${value.connections.length + 1}`, format: "openai", baseURL: DEFAULT_URLS.openai, hasKey: false, discover: true, models: [] }] })
  return <form onSubmit={e => { e.preventDefault(); save.mutate() }} className="border-t border-border p-5">
    <FieldGroup>
      <p className="text-xs text-muted-foreground">API keys are encrypted on this server and never returned to your browser. Leave a saved key blank to keep it. Re-enter or clear a saved key when changing its URL or API format. A key is optional for local APIs that do not require authentication.</p>
      {value.connections.map(c => <ProviderConnection key={c.id} value={c} disabled={save.isPending} onChange={change => connection(c.id, change)} onRemove={() => update({ ...value, connections: value.connections.filter(item => item.id !== c.id) })} />)}
      <Button type="button" onClick={add} variant="outline" disabled={save.isPending}>Add provider</Button>
      {save.isError && <p role="alert" className="text-sm text-failed">{save.error.message}</p>}
      {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Provider settings saved.</p>}
      <p className="text-xs text-muted-foreground">Models from all saved connections appear in the model picker when starting an agent. Add more connections at any time to expand your choices. Token usage is recorded; provider billing remains with your provider.</p>
      <Button disabled={save.isPending || !value.connections.length} type="submit">{save.isPending ? "Saving…" : setup ? "Finish setup" : "Save provider settings"}</Button>
    </FieldGroup>
  </form>
}
