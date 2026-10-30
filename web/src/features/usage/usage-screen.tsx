import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Shell } from "../studio/shell"
import { Section, Row } from "../studio/section"
interface Usage { period: string; models: { model_id: string; input: number; output: number; cache_read: number }[]; total: { input: number; output: number; cache_read: number } }
export function UsageScreen() {
  const q = useQuery({ queryKey: ["usage"], queryFn: () => api<Usage>("/v1/usage"), refetchInterval: 60_000 })
  return <Shell active="Usage" crumbs={<span>Usage</span>} contentClassName="overflow-y-auto"><div className="mx-auto max-w-[760px] space-y-5 px-5 py-10"><h1 className="text-3xl font-semibold">Usage</h1><p className="text-sm text-muted-foreground">Model usage recorded by this server{q.data ? ` for ${q.data.period}` : ""}.</p>
    {q.isPending ? <p>Loading…</p> : q.isError ? <p role="alert">Couldn't load usage.</p> : <><Section title="Tokens" description="Total token usage this month."><Row label="Input">{q.data.total.input.toLocaleString()}</Row><Row label="Output">{q.data.total.output.toLocaleString()}</Row><Row label="Cache reads">{q.data.total.cache_read.toLocaleString()}</Row></Section><Section title="Models" description="Usage by model.">{q.data.models.length ? q.data.models.map(m => <Row key={m.model_id} label={m.model_id}>{(m.input + m.output + m.cache_read).toLocaleString()} tokens</Row>) : <p className="p-5 text-sm text-muted-foreground">No usage yet.</p>}</Section></>}
  </div></Shell>
}
