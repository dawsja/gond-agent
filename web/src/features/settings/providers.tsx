import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Check } from "lucide-react"
import { api } from "@/lib/api"
import { randomId } from "@/lib/id"
import { DEFAULT_URLS, type Connection, type ProviderSettingsValue } from "@/lib/provider-settings"
import { Button } from "@shared/ui/button"
import { FieldGroup } from "@shared/ui/field"
import { Section } from "../studio/section"
import { ProviderConnection } from "./provider-connection"

export function ProviderSettings({ setup = false }: { setup?: boolean }) {
  const query = useQuery({ queryKey: ["providers"], queryFn: () => api<ProviderSettingsValue>("/v1/settings/providers") })
  if (query.data) return <ProviderForm initial={query.data} setup={setup} />
  return <Section title={setup ? "Connect your API" : "Model providers"} description="Choose a provider, add your key, then save.">{query.isError ? <p role="alert" className="p-5 text-sm text-failed">{query.error.message}</p> : <p className="p-5 text-sm">Loading…</p>}</Section>
}

const newConnection = (): Connection => ({ id: randomId(), name: "OpenAI", format: "openai", baseURL: DEFAULT_URLS.openai, hasKey: false, discover: true, models: [] })

function ProviderForm({ initial, setup }: { initial: ProviderSettingsValue; setup: boolean }) {
  const [value, setValue] = useState(() => setup && !initial.connections.length ? { ...initial, connections: [newConnection()] } : initial)
  const [saved, setSaved] = useState(initial), qc = useQueryClient()
  const update = (next: ProviderSettingsValue) => { setValue(next); save.reset() }
  const connection = (id: string, change: Partial<Connection>) => update({ ...value, connections: value.connections.map(c => c.id === id ? { ...c, ...change } : c) })
  const save = useMutation({
    mutationFn: () => api<ProviderSettingsValue>("/v1/settings/providers", { method: "PUT", body: { ...value, connections: value.connections.map(c => ({ ...c, name: c.name.trim() || (c.format === "anthropic" ? "Anthropic" : "OpenAI") })), defaultModel: value.connections.some(c => value.defaultModel.startsWith(c.id + ":")) ? value.defaultModel : "" } }),
    onSuccess: data => {
      setValue(data); setSaved(data); qc.setQueryData(["providers"], data)
      void qc.invalidateQueries({ queryKey: ["models"] }); void qc.invalidateQueries({ queryKey: ["me"] })
    },
  })
  const add = () => update({ ...value, connections: [...value.connections, newConnection()] })
  return <Section title={setup ? "Connect your API" : "Model providers"} description="Choose a provider, add your key, then save." actionBeside action={<Button variant="link" className="h-auto px-0 py-0 text-xs" disabled={save.isPending || value.connections.length >= 20} onClick={add}>+ Add provider</Button>}>
    <form onSubmit={e => { e.preventDefault(); save.mutate() }} onInvalidCapture={e => { const details = (e.target as HTMLElement).closest("details"); if (details) details.open = true }}>
      <FieldGroup className="gap-0">
        {value.connections.map(c => <div key={c.id} className="border-t border-border p-5 sm:p-7"><ProviderConnection value={c} saved={saved.connections.find(item => item.id === c.id)} multiple={value.connections.length > 1} disabled={save.isPending} onChange={change => connection(c.id, change)} onRemove={() => update({ ...value, connections: value.connections.filter(item => item.id !== c.id) })} /></div>)}
        {!value.connections.length && <p className="border-t border-border p-5 text-sm text-muted-foreground">No API providers. Subscription agents work without an API connection.</p>}
        {save.isError && <p role="alert" className="px-5 pb-4 text-sm text-failed">{save.error.message}</p>}
        {save.isSuccess && <p role="status" className="px-5 pb-4 text-sm text-muted-foreground">Provider settings saved.</p>}
        <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-4 sm:px-7"><p className="flex items-center gap-2 text-xs text-muted-foreground"><Check className="size-3.5 shrink-0" />Models appear automatically</p><Button disabled={save.isPending || (setup && !value.connections.length)} type="submit">{save.isPending ? "Saving…" : setup ? "Finish setup" : "Save changes"}</Button></div>
      </FieldGroup>
    </form>
  </Section>
}
