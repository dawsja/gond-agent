import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api } from "@/lib/api"
import { Section } from "../studio/section"
interface OIDC { enabled: boolean; name: string; issuer: string; clientId: string; hasSecret: boolean; callbackURL: string }
export function OIDCSettings() {
  const query = useQuery({ queryKey: ["oidc"], queryFn: () => api<OIDC>("/v1/settings/oidc") })
  return <Section title="OpenID Connect" description="Let people sign in with your identity provider.">
    {query.isPending ? <p className="p-5 text-sm">Loading…</p> : query.isError ? <p role="alert" className="p-5 text-sm text-failed">Couldn't load sign-in settings.</p> : <OIDCForm initial={query.data} />}
  </Section>
}
function OIDCForm({ initial }: { initial: OIDC }) {
  const [value, setValue] = useState({ ...initial, clientSecret: "" }), qc = useQueryClient()
  const save = useMutation({ mutationFn: () => api("/v1/settings/oidc", { method: "PUT", body: value }), onSuccess: () => { setValue(v => ({ ...v, clientSecret: "" })); void qc.invalidateQueries({ queryKey: ["oidc"] }) } })
  const field = "mt-1.5 h-10 w-full rounded-[4px] border border-border-strong bg-background px-3 text-sm outline-none focus:border-link"
  return <form onSubmit={e => { e.preventDefault(); save.mutate() }} className="space-y-4 border-t border-border p-5">
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={value.enabled} onChange={e => setValue({ ...value, enabled: e.target.checked })} /> Enable single sign-on</label>
    <label className="block text-sm">Button label<input className={field} value={value.name} onChange={e => setValue({ ...value, name: e.target.value })} /></label>
    <label className="block text-sm">Issuer URL<input type="url" placeholder="https://identity.example.com/realms/team" required={value.enabled} className={field} value={value.issuer} onChange={e => setValue({ ...value, issuer: e.target.value })} /></label>
    <label className="block text-sm">Client ID<input required={value.enabled} className={field} value={value.clientId} onChange={e => setValue({ ...value, clientId: e.target.value })} /></label>
    <label className="block text-sm">Client secret<input type="password" autoComplete="new-password" placeholder={initial.hasSecret ? "Saved — leave blank to keep" : "Enter client secret"} required={value.enabled && !initial.hasSecret} className={field} value={value.clientSecret} onChange={e => setValue({ ...value, clientSecret: e.target.value })} /></label>
    <p className="break-all text-xs text-muted-foreground">Redirect URI: <code>{initial.callbackURL}</code></p>
    <p className="text-xs text-muted-foreground">The provider must support OpenID Connect discovery and verified ID tokens. Password sign-in remains available.</p>
    {save.isError && <p role="alert" className="text-sm text-failed">{save.error.message}</p>}
    {save.isSuccess && <p role="status" className="text-sm text-muted-foreground">Saved.</p>}
    <button disabled={save.isPending} className="h-9 rounded-[4px] border border-border-strong px-4 text-sm disabled:opacity-50">{save.isPending ? "Saving…" : "Save sign-in settings"}</button>
  </form>
}
