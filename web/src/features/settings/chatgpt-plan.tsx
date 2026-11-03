// "Sign in with ChatGPT" for the built-in agent, following OpenAI's UI guidelines:
// https://developers.openai.com/siwc/ui-ux-guidelines
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ExternalLink } from "lucide-react"
import { api, type Model, type ModelConnection, type SubscriptionAccount, type Subscriptions } from "@/lib/api"
import { MODEL_PROVIDER_ICONS } from "@shared/provider-icons"
import { Button } from "@shared/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@shared/ui/dialog"
import { Input } from "@shared/ui/input"
import { cn } from "@/lib/utils"
import { Section } from "../studio/section"

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage"
const CALLBACK = "http://127.0.0.1:1455/auth/callback"

function OpenAIMark({ className, inverted = false }: { className?: string; inverted?: boolean }) {
  return <span aria-hidden="true" className={cn("inline-block size-4 shrink-0 bg-contain bg-center bg-no-repeat", inverted && "invert", className)} style={{ backgroundImage: `url("${MODEL_PROVIDER_ICONS.openai}")` }} />
}

export function ContinueWithChatGPT({ onClick, disabled, children = "Continue with ChatGPT" }: { onClick: () => void; disabled?: boolean; children?: string }) {
  return <Button onClick={onClick} disabled={disabled} className="border border-black/10 bg-white text-black hover:bg-white/90"><OpenAIMark />{children}</Button>
}

const subscriptionsQuery = { queryKey: ["subscriptions"], queryFn: () => api<Subscriptions>("/v1/subscriptions") }

function status(account: SubscriptionAccount) {
  if (account.status === "signed_out") return "Signed out"
  if (account.status === "reauth") return "Sign in again to keep using this account"
  if (account.plan === "not_eligible") return "Plan usage isn't available for this account"
  if (account.plan === "disabled") return "Plan use wasn't allowed during sign-in"
  if (account.limited) return "Usage limit reached"
  return "Using ChatGPT plan"
}

export function ChatGPTPlanSettings({ setup = false }: { setup?: boolean }) {
  const qc = useQueryClient()
  const query = useQuery(subscriptionsQuery)
  const [pasted, setPasted] = useState("")
  const [notice, setNotice] = useState("")
  const refresh = () => Promise.all(["subscriptions", "models", "me"].map(key => qc.invalidateQueries({ queryKey: [key] })))
  const start = useMutation({
    mutationFn: async (accountId?: string) => {
      // Open the tab inside the click so browsers don't block it, then point it at the sign-in page.
      const tab = window.open("", "_blank")
      try {
        const pending = await api<{ url: string }>("/v1/subscriptions/chatgpt/login", { body: accountId ? { account_id: accountId } : {} })
        if (tab) { tab.opener = null; tab.location.href = pending.url }
        return pending
      } catch (error) { tab?.close(); throw error }
    },
    onSuccess: () => { setPasted(""); setNotice(""); void refresh() },
  })
  const finish = useMutation({
    mutationFn: () => api("/v1/subscriptions/chatgpt/callback", { body: { url: pasted.trim() } }),
    onSuccess: () => { setPasted(""); void refresh() },
  })
  const cancel = useMutation({ mutationFn: () => api("/v1/subscriptions/chatgpt/login", { method: "DELETE" }), onSuccess: () => { finish.reset(); void refresh() } })
  const signOut = useMutation({
    mutationFn: (id: string) => api<{ revoked: boolean }>(`/v1/subscriptions/accounts/${id}/sign-out`, { body: {} }),
    onSuccess: result => { setNotice(result.revoked ? "Signed out of ChatGPT." : "Signed out here. ChatGPT didn't confirm the session ended; you can also disconnect Gond Agent in ChatGPT settings."); void refresh() },
  })
  const remove = useMutation({ mutationFn: (id: string) => api(`/v1/subscriptions/accounts/${id}`, { method: "DELETE" }), onSuccess: () => { setNotice("Account removed."); void refresh() } })
  const busy = start.isPending || finish.isPending || cancel.isPending || signOut.isPending || remove.isPending
  const pending = query.data?.pending
  const error = start.error ?? finish.error ?? cancel.error ?? signOut.error ?? remove.error
  return <Section title="ChatGPT plan" description="Use your ChatGPT plan for eligible requests from the built-in agent. Usage counts toward your ChatGPT plan limits. Gond Agent never switches these requests to API billing." actionBeside action={query.data?.accounts.length ? <Button variant="link" className="h-auto px-0 py-0 text-xs" disabled={busy || !!pending} onClick={() => start.mutate(undefined)}>+ Add ChatGPT account</Button> : undefined}>
    {query.isPending && <p className="border-t border-border p-5 text-sm">Loading…</p>}
    {query.isError && <p role="alert" className="border-t border-border p-5 text-sm text-failed">{query.error.message}</p>}
    {query.data && <>
      {query.data.accounts.map(account => <div key={account.id} className="flex flex-col gap-3 border-t border-border p-5 sm:px-7"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3"><span className="grid size-8 shrink-0 place-items-center rounded-full bg-white"><OpenAIMark /></span><div className="min-w-0"><p className="truncate text-sm font-medium">{account.email ?? "ChatGPT account"}</p><p className={cn("text-xs", account.status === "active" && account.plan === "enabled" && !account.limited ? "text-muted-foreground" : "text-amber-300")}>{status(account)}</p></div></div>
        <div className="flex flex-wrap items-center gap-2">
          {(account.status !== "active" || account.plan === "disabled") && <ContinueWithChatGPT disabled={busy || !!pending} onClick={() => start.mutate(account.id)} />}
          <Button asChild variant="ghost" size="sm"><a href={account.usage_url ?? CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage<ExternalLink /></a></Button>
          {account.status === "active" && <Button variant="outline" size="sm" disabled={busy} onClick={() => signOut.mutate(account.id)}>Sign out</Button>}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove.mutate(account.id)}>Remove</Button>
        </div></div>
        {account.limited && account.status === "active" && <UsageLimitCard />}
      </div>)}
      {!query.data.accounts.length && !pending && <div className="flex flex-col items-start gap-3 border-t border-border p-5 sm:px-7">
        <p className="text-sm text-muted-foreground">{setup ? "Sign in with ChatGPT to use your plan, or add an API provider below." : "No ChatGPT accounts. Sign in to use your plan with the built-in agent."}</p>
        <ContinueWithChatGPT disabled={busy} onClick={() => start.mutate(undefined)} />
      </div>}
      {pending && <div className="flex flex-col gap-3 border-t border-border p-5 sm:px-7">
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
          <li>Approve Gond Agent on the ChatGPT page. <a className="text-link" href={pending.url} target="_blank" rel="noreferrer">Open it again</a> if it didn't open.</li>
          <li>The browser then shows a page that can't load, starting with <code className="text-foreground">{CALLBACK}</code>.</li>
          <li>Copy that whole address from the address bar and paste it here.</li>
        </ol>
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={e => { e.preventDefault(); if (pasted.trim()) finish.mutate() }}>
          <Input aria-label="Address of the page that didn't load" className="min-w-0 sm:flex-1" placeholder={`${CALLBACK}?code=…`} value={pasted} onChange={e => { setPasted(e.target.value); finish.reset() }} autoComplete="off" spellCheck={false} />
          <div className="flex shrink-0 gap-2"><Button type="submit" disabled={busy || !pasted.trim()}>{finish.isPending ? "Finishing…" : "Finish sign-in"}</Button><Button variant="ghost" disabled={busy} onClick={() => cancel.mutate()}>Cancel</Button></div>
        </form>
        <p className="text-xs text-muted-foreground">This sign-in expires at {new Date(pending.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Gond Agent only reads the address; it never opens it.</p>
      </div>}
      {error && <p role="alert" className="border-t border-border px-5 py-4 text-sm text-failed sm:px-7">{error.message}</p>}
      {notice && !error && <p role="status" className="border-t border-border px-5 py-4 text-sm text-muted-foreground sm:px-7">{notice}</p>}
    </>}
  </Section>
}

/** Shown once after the first successful sign-in, wherever the person lands next. */
export function ChatGPTWelcome() {
  const qc = useQueryClient(), open = !!useQuery(subscriptionsQuery).data?.welcome
  const done = useMutation({ mutationFn: () => api("/v1/subscriptions/welcome", { body: {} }), onSettled: () => qc.invalidateQueries({ queryKey: ["subscriptions"] }) })
  return <Dialog open={open && !done.isSuccess} onOpenChange={next => { if (!next) done.mutate() }}>
    <DialogContent>
      <span className="grid size-10 place-items-center rounded-full bg-white"><OpenAIMark className="size-5" /></span>
      <DialogTitle className="text-lg font-semibold">You're using your ChatGPT plan</DialogTitle>
      <DialogDescription className="text-sm text-muted-foreground">Eligible requests from Gond Agent's built-in agent now use your ChatGPT plan instead of API billing. Usage counts toward your plan limits, which you can review in ChatGPT settings.</DialogDescription>
      <div className="flex flex-wrap justify-end gap-2"><Button asChild variant="ghost"><a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage<ExternalLink /></a></Button><Button onClick={() => done.mutate()}>Got it</Button></div>
    </DialogContent>
  </Dialog>
}

export function UsageLimitCard({ className }: { className?: string }) {
  return <div role="status" className={cn("flex flex-col gap-3 rounded-md border border-border-strong bg-card p-4", className)}>
    <div className="flex items-center gap-2 text-sm font-medium"><span className="grid size-6 place-items-center rounded-full bg-white"><OpenAIMark className="size-3.5" /></span>Usage limit reached</div>
    <p className="text-sm text-muted-foreground">You've reached a ChatGPT plan usage limit for Gond Agent. Gond Agent won't switch to API billing. Review your limits in ChatGPT settings, or choose a model from an API connection.</p>
    <Button asChild size="sm" className="self-start"><a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage<ExternalLink /></a></Button>
  </div>
}

/** "Using ChatGPT plan" next to the model picker, with the usage-limit card when the plan is paused. */
export function PlanIndicator({ model, connections }: { model?: Model; connections?: ModelConnection[] }) {
  if (!model?.access || model.access === "api") return null
  const connection = connections?.find(c => c.id === model.connection_id)
  return <div className="mt-2 flex flex-col gap-2 px-1">
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground"><OpenAIMark inverted className="size-3.5 opacity-80" />Using ChatGPT plan<a className="text-link" href={connection?.usage_url ?? CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">Manage usage</a></p>
    {connection?.limited && <UsageLimitCard />}
  </div>
}
