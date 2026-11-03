import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, Plug } from "lucide-react"
import { api, type GithubLogin } from "@/lib/api"
import { useMe } from "@/lib/queries"
import { Button } from "@shared/ui/button"
import { Input } from "@shared/ui/input"
import { Field, FieldLabel } from "@shared/ui/field"
import { Shell } from "../studio/shell"
import { Section, Row } from "../studio/section"

export function PluginsScreen() {
  const { data: me } = useMe()
  return <Shell active="Plugins" crumbs={<span>Connections</span>} contentClassName="overflow-y-auto"><div className="mx-auto flex max-w-[760px] flex-col gap-5 px-5 py-10"><h1 className="text-3xl font-semibold">Connections</h1><GithubConnection />{me?.admin && <GithubConnection shared />}</div></Shell>
}

export function GithubConnection({ shared = false }: { shared?: boolean }) {
  const qc = useQueryClient(), path = shared ? "/v1/settings/github" : "/v1/github", key = shared ? "shared-github" : "github"
  const github = useQuery({ queryKey: [key], queryFn: () => api<{ configured: boolean; login: string | null; managed: boolean; fallback?: boolean }>(path) })
  const login = useQuery({ queryKey: [key, "login"], queryFn: () => api<GithubLogin>(`${path}/login`),
    refetchInterval: q => ["starting", "pending", "busy"].includes(q.state.data?.status ?? "") ? 1500 : false })
  const update = (state: GithubLogin) => qc.setQueryData([key, "login"], state)
  const start = useMutation({ mutationFn: () => api<GithubLogin>(`${path}/login`, { method: "POST" }), onSuccess: update })
  const cancel = useMutation({ mutationFn: () => api<GithubLogin>(`${path}/login`, { method: "DELETE", body: { id: login.data?.id } }), onSuccess: update })
  const disconnect = useMutation({ mutationFn: () => api(path, { method: "DELETE" }), onSuccess: () => { update({ status: "idle" }); for (const k of [key, "github", "repos", "branches"]) void qc.invalidateQueries({ queryKey: [k] }) } })
  const fallback = useMutation({ mutationFn: (value: boolean) => api(path, { method: "PUT", body: { fallback: value } }), onSuccess: () => { void qc.invalidateQueries({ queryKey: [key] }); void qc.invalidateQueries({ queryKey: ["github"] }) } })
  const status = login.data?.status
  const pending = start.isPending || status === "starting" || status === "pending"
  useEffect(() => {
    if (status && !["starting", "pending", "busy"].includes(status)) for (const item of [key, "github", "repos", "branches"]) void qc.invalidateQueries({ queryKey: [item] })
  }, [status, qc, key])
  const error = start.error ?? cancel.error ?? disconnect.error ?? fallback.error ?? login.error
  return <Section title={shared ? "Shared connection" : "GitHub"} icon={<Plug className="size-5 shrink-0" />} description={shared ? "Shared connection (used by accounts without their own). New accounts need their own connection unless the fallback is on." : "Connect your own GitHub account here. Your runs and pull requests use it."}>
      <Row label="Status">{github.isPending ? "Checking…" : github.isError ? "Couldn't check GitHub" : github.data?.configured ? `Signed in as ${github.data.login}` : "Not connected"}</Row>
      <div className="flex flex-col gap-4 border-t border-border px-5 py-4 max-md:px-4">
        <>
          {shared && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={!!github.data?.fallback} disabled={fallback.isPending} onChange={e => fallback.mutate(e.target.checked)} />Use the shared GitHub connection for accounts without their own</label>}
          {!shared && github.data?.configured && !github.data.managed && <p className="text-sm text-muted-foreground">Using shared or service credentials. Connect your own account to override them.</p>}
          <p className="text-sm text-muted-foreground">GitHub CLI is already installed. Sign in here, then approve the one-time code on GitHub. No terminal or download is needed.</p>
          {pending && <p role="status" className="text-sm">{status === "pending" ? "Waiting for approval on GitHub…" : "Requesting a sign-in code…"}</p>}
          {status === "pending" && <>
            <Field><FieldLabel htmlFor={`${key}-code`}>One-time code</FieldLabel><Input id={`${key}-code`} readOnly value={login.data?.code ?? ""} onFocus={e => e.currentTarget.select()} className="max-w-64 font-mono" /></Field>
            <p className="text-xs text-muted-foreground">Only approve the code shown here. {login.data?.expiresAt && `Expires at ${new Date(login.data.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}</p>
            <Button asChild className="self-start"><a href="https://github.com/login/device" target="_blank" rel="noreferrer">Continue on GitHub<ExternalLink data-icon="inline-end" /></a></Button>
          </>}
          {status === "busy" && <p role="status" className="text-sm text-muted-foreground">Another session of your account is connecting GitHub. This page will update when it finishes.</p>}
          {status === "expired" && <p role="status" className="text-sm text-muted-foreground">The code expired. Start again to get a new code.</p>}
          {status === "cancelled" && <p role="status" className="text-sm text-muted-foreground">GitHub sign-in cancelled.</p>}
          {status === "error" && <p role="alert" className="text-sm text-failed">{login.data?.message}</p>}
          {status === "connected" && <p role="status" className="text-sm">GitHub connected.</p>}
          {error && <p role="alert" className="text-sm text-failed">{error.message}</p>}
          {pending ? <Button variant="outline" className="self-start" disabled={!login.data?.id || cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending ? "Cancelling…" : "Cancel sign-in"}</Button> : <Button variant="outline" className="self-start" disabled={login.isPending || status === "busy"} onClick={() => { cancel.reset(); start.mutate() }}>{github.data?.managed ? "Reconnect GitHub" : "Connect GitHub"}</Button>}
          {github.data?.managed && <Button variant="outline" className="self-start" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button>}
          <p className="text-xs text-muted-foreground">The approved credential is encrypted on this server and never sent to a worker. Reconnecting replaces the saved connection only after approval.</p>
        </>
      </div>
    </Section>
}
