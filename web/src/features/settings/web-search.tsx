import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Button } from "@shared/ui/button"
import { Input, NativeSelect } from "@shared/ui/input"
import { Field, FieldLabel } from "@shared/ui/field"
import { Section } from "../studio/section"

interface SearchSettings { provider: "none" | "brave"; hasKey: boolean; configured: boolean; message: string }
export function WebSearchSettings() {
  const query = useQuery({ queryKey: ["web-search"], queryFn: () => api<SearchSettings>("/v1/settings/web-search") })
  return <Section title="Web search" description="Optional web search for new workspaces. Search keys stay encrypted on this server, never in a worker.">
    {query.isPending ? <p className="p-5 text-sm">Loading…</p> : query.isError ? <p role="alert" className="p-5 text-sm text-failed">Could not load web search settings.</p> : <SearchForm key={`${query.data.provider}-${query.data.hasKey}`} initial={query.data} />}
  </Section>
}
function SearchForm({ initial }: { initial: SearchSettings }) {
  const [provider, setProvider] = useState(initial.provider)
  const [apiKey, setKey] = useState("")
  const [clearKey, setClear] = useState(false)
  const qc = useQueryClient()
  const save = useMutation({ mutationFn: () => api<SearchSettings>("/v1/settings/web-search", { method: "PUT", body: { provider, apiKey, clearKey } }), onSuccess: () => { setKey(""); setClear(false); void qc.invalidateQueries({ queryKey: ["web-search"] }) } })
  const test = useMutation({ mutationFn: () => api("/v1/settings/web-search/test", { method: "POST", body: {} }) })
  return <form onSubmit={e => { e.preventDefault(); save.mutate() }} className="space-y-5 border-t border-border p-5">
    <Field><FieldLabel htmlFor="search-provider">Provider</FieldLabel><NativeSelect id="search-provider" value={provider} onChange={e => setProvider(e.target.value as SearchSettings["provider"])}><option value="none">Disabled</option><option value="brave">Brave Search API</option></NativeSelect></Field>
    <Field><div className="flex items-center justify-between gap-3"><FieldLabel htmlFor="search-key">Brave Search API key</FieldLabel>{initial.hasKey && !clearKey && <Button type="button" variant="link" size="sm" onClick={() => { setClear(true); setKey("") }}>Clear key</Button>}</div>
      <Input id="search-key" type="password" autoComplete="new-password" maxLength={4096} value={apiKey} placeholder={initial.hasKey && !clearKey ? "Saved — paste a new key to replace" : "Paste your Brave Search API key"} onChange={e => { setKey(e.target.value); setClear(false) }} />
      {clearKey && <div role="status" className="flex items-center justify-between text-xs"><span>Key will be cleared when you save.</span><Button type="button" variant="link" size="sm" onClick={() => setClear(false)}>Undo</Button></div>}
    </Field>
    <p className="text-xs text-muted-foreground">Brave offers a free tier. An administrator enters the key here, never in chat or the repository. Save before testing.</p>
    <p className="text-xs text-muted-foreground">web_search is absent when no provider and key are configured. No automatic fallback or always-on search is used.</p>
    <div className="flex flex-wrap gap-3"><Button type="submit" disabled={save.isPending}>Save web search</Button><Button type="button" variant="outline" disabled={test.isPending || !initial.configured} onClick={() => test.mutate()}>{test.isPending ? "Testing…" : "Test saved settings"}</Button></div>
    {(save.isError || test.isError) && <p role="alert" className="text-sm text-failed">{save.error?.message ?? test.error?.message}</p>}
    {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Saved. New workspaces use these settings.</p>}
    {test.isSuccess && <p role="status" className="text-sm text-muted-foreground">Search connection works.</p>}
  </form>
}
