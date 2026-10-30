import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Section } from "../studio/section"
interface Session { token: string; userAgent?: string; createdAt: string; updatedAt: string }
export function SessionsSection() {
  const qc = useQueryClient(), q = useQuery({ queryKey: ["sessions"], queryFn: () => api<{ sessions: Session[]; currentToken: string }>("/v1/sessions") })
  const revoke = useMutation({ mutationFn: (token: string) => api("/v1/sessions/revoke", { body: { token } }), onSuccess: () => void qc.invalidateQueries({ queryKey: ["sessions"] }) })
  return <Section title="Sessions" description="Where you're signed in. Revoke any session you don't recognize.">
    {q.isPending ? <p className="p-5 text-sm">Loading…</p> : q.isError ? <p className="p-5 text-sm text-failed">Couldn't load sessions.</p> : q.data.sessions.map(s => <div key={s.token} className="flex items-center gap-3 border-t border-border p-5 text-sm"><div className="min-w-0 flex-1"><p className="truncate">{s.userAgent || "Browser"}</p><p className="mt-1 text-xs text-muted-foreground">Active {new Date(s.updatedAt).toLocaleString()}</p></div>{s.token === q.data.currentToken ? <span className="text-xs text-link">Current session</span> : <button disabled={revoke.isPending} onClick={() => revoke.mutate(s.token)} className="rounded-[4px] border border-border-strong px-3 py-1.5">Revoke</button>}</div>)}
    {revoke.isError && <p role="alert" className="p-5 text-sm text-failed">Couldn't revoke that session.</p>}
  </Section>
}
