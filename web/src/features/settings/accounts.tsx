import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Button } from "@shared/ui/button"
import { Section } from "../studio/section"

interface Methods { methods: { id: string; provider: string }[]; providers: { id: string; name: string }[] }
export function SignInMethods() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ["sign-in-methods"], queryFn: () => api<Methods>("/v1/me/sign-in-methods") })
  const link = useMutation({ mutationFn: () => api<{ url: string }>("/auth/link-social", { method: "POST", body: { provider: "oidc", callbackURL: new URL("/agents/settings#sign-in-methods", location.origin).href, errorCallbackURL: new URL("/agents/settings#sign-in-methods", location.origin).href } }), onSuccess: result => { location.assign(result.url) } })
  const unlink = useMutation({ mutationFn: (id: string) => api("/auth/unlink-account", { method: "POST", body: { accountId: id } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["sign-in-methods"] }) } })
  const error = query.error ?? link.error ?? unlink.error
  const callbackError = new URLSearchParams(location.search).get("error")
  return <Section title="Sign-in methods" description="Link single sign-on to this account after a recent sign-in. Email addresses never link accounts automatically.">
    <div className="space-y-4 border-t border-border p-5">
      {query.data?.methods.map(method => <div key={method.id} className="flex items-center justify-between gap-3"><span className="text-sm">{method.provider === "credential" ? "Password" : query.data?.providers.find(p => p.id === method.provider)?.name ?? method.provider}</span>{method.provider !== "credential" && query.data!.methods.length > 1 && <Button variant="outline" disabled={unlink.isPending} onClick={() => unlink.mutate(method.id)}>Unlink</Button>}</div>)}
      {query.data?.providers.filter(provider => !query.data.methods.some(method => method.provider === provider.id)).map(provider => <Button key={provider.id} variant="outline" disabled={link.isPending} onClick={() => link.mutate()}>Link {provider.name}</Button>)}
      {callbackError && <p role="alert" className="text-sm text-failed">{callbackError.includes("already_linked") ? "This identity is already linked to another account. Ask an administrator to promote that account instead." : "Sign-in linking did not finish. Sign in again and retry."}</p>}
      {error && <p role="alert" className="text-sm text-failed">{error.message}</p>}
      <p className="text-xs text-muted-foreground">Keep at least one sign-in method. Administrators can promote a separate account without merging its data.</p>
    </div>
  </Section>
}
interface Person { id: string; name: string; email: string; admin: boolean; methods: string[] }
export function People() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ["people"], queryFn: () => api<{ people: Person[] }>("/v1/settings/people") })
  const role = useMutation({ mutationFn: (person: Person) => api(`/v1/settings/people/${encodeURIComponent(person.id)}/role`, { method: "PUT", body: { admin: !person.admin } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["people"] }); void qc.invalidateQueries({ queryKey: ["me"] }) } })
  return <Section title="People" description="Manage administrator permissions. Administrators manage instance settings, not other accounts' personal connections."><div className="space-y-5 border-t border-border p-5">
    {query.data?.people.map(person => <div key={person.id} className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0 text-sm"><p className="break-all font-medium">{person.name} · {person.admin ? "Administrator" : "Member"}</p><p className="break-all text-muted-foreground">{person.email}</p><p className="text-xs text-muted-foreground">{person.methods.map(method => method === "credential" ? "Password" : method).join(", ")}</p></div><Button variant="outline" disabled={role.isPending} onClick={() => role.mutate(person)}>{person.admin ? "Remove administrator" : "Make administrator"}</Button></div>)}
    {(query.error ?? role.error) && <p role="alert" className="text-sm text-failed">{(query.error ?? role.error)?.message}</p>}
  </div></Section>
}
