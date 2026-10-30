import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ExternalLink, Plug } from "lucide-react"
import { api, type GithubLogin } from "@/lib/api"
import { useGithub, useMe } from "@/lib/queries"
import { Button } from "@shared/ui/button"
import { Input } from "@shared/ui/input"
import { Field, FieldLabel } from "@shared/ui/field"
import { Shell } from "../studio/shell"
import { Section, Row } from "../studio/section"

export function PluginsScreen() {
  const github = useGithub(), { data: me } = useMe(), qc = useQueryClient()
  const login = useQuery({ queryKey: ["github-login"], queryFn: () => api<GithubLogin>("/v1/github/login"), enabled: !!me?.admin,
    refetchInterval: q => ["starting", "pending", "busy"].includes(q.state.data?.status ?? "") ? 1500 : false })
  const update = (state: GithubLogin) => qc.setQueryData(["github-login"], state)
  const start = useMutation({ mutationFn: () => api<GithubLogin>("/v1/github/login", { method: "POST" }), onSuccess: update })
  const cancel = useMutation({ mutationFn: () => api<GithubLogin>("/v1/github/login", { method: "DELETE", body: { id: login.data?.id } }), onSuccess: update })
  const status = login.data?.status
  const pending = start.isPending || status === "starting" || status === "pending"
  useEffect(() => {
    if (status && !["starting", "pending", "busy"].includes(status)) for (const key of ["github", "repos", "branches"]) void qc.invalidateQueries({ queryKey: [key] })
  }, [status, qc])
  const error = start.error ?? cancel.error ?? login.error
  return <Shell active="Plugins" crumbs={<span>Plugins</span>} contentClassName="overflow-y-auto"><div className="mx-auto flex max-w-[760px] flex-col gap-5 px-5 py-10"><h1 className="text-3xl font-semibold">Connections</h1>
    <Section title="GitHub" icon={<Plug className="size-5 shrink-0" />} description="Connect an account to give this instance access to its repositories. All workspace accounts share this connection.">
      <Row label="Status">{github.isPending ? "Checking…" : github.isError ? "Couldn't check GitHub" : github.data?.configured ? `Signed in as ${github.data.login}` : "Not connected"}</Row>
      <div className="flex flex-col gap-4 border-t border-border px-5 py-4 max-md:px-4">
        {me?.admin ? <>
          <p className="text-sm text-muted-foreground">GitHub CLI is already installed. Sign in here, then approve the one-time code on GitHub. No terminal or download is needed.</p>
          {pending && <p role="status" className="text-sm">{status === "pending" ? "Waiting for approval on GitHub…" : "Requesting a sign-in code…"}</p>}
          {status === "pending" && <>
            <Field><FieldLabel htmlFor="github-code">One-time code</FieldLabel><Input id="github-code" readOnly value={login.data?.code ?? ""} onFocus={e => e.currentTarget.select()} className="max-w-64 font-mono" /></Field>
            <p className="text-xs text-muted-foreground">Only approve the code shown here. {login.data?.expiresAt && `Expires at ${new Date(login.data.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`}</p>
            <Button asChild className="self-start"><a href="https://github.com/login/device" target="_blank" rel="noreferrer">Continue on GitHub<ExternalLink data-icon="inline-end" /></a></Button>
          </>}
          {status === "busy" && <p role="status" className="text-sm text-muted-foreground">Another administrator session is connecting GitHub. This page will update when it finishes.</p>}
          {status === "expired" && <p role="status" className="text-sm text-muted-foreground">The code expired. Start again to get a new code.</p>}
          {status === "cancelled" && <p role="status" className="text-sm text-muted-foreground">GitHub sign-in cancelled.</p>}
          {status === "error" && <p role="alert" className="text-sm text-failed">{login.data?.message}</p>}
          {status === "connected" && <p role="status" className="text-sm">GitHub connected.</p>}
          {error && <p role="alert" className="text-sm text-failed">{error.message}</p>}
          {pending ? <Button variant="outline" className="self-start" disabled={!login.data?.id || cancel.isPending} onClick={() => cancel.mutate()}>{cancel.isPending ? "Cancelling…" : "Cancel sign-in"}</Button> : <Button variant="outline" className="self-start" disabled={login.isPending || status === "busy"} onClick={() => { cancel.reset(); start.mutate() }}>{github.data?.configured ? "Reconnect GitHub" : "Sign in to GitHub"}</Button>}
          <p className="text-xs text-muted-foreground">The approved credential is encrypted on this server and never sent to a worker. Reconnecting replaces the saved connection only after approval.</p>
        </> : <p className="text-sm text-muted-foreground">An administrator can connect GitHub here for everyone on this instance.</p>}
      </div>
    </Section>
  </div></Shell>
}
