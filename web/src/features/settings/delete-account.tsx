import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { useMe } from "@/lib/queries"
import { Button } from "@shared/ui/button"
import { Input } from "@shared/ui/input"
import { Field, FieldGroup, FieldLabel } from "@shared/ui/field"
import { ConfirmDialog } from "../studio/confirm-dialog"
import { Section } from "../studio/section"

interface DeletionPolicy { last_account: boolean; has_password: boolean; blocked_reason: string | null }

export function DeleteAccount() {
  const { data: me } = useMe()
  const [open, setOpen] = useState(false), [confirmation, setConfirmation] = useState(""), [password, setPassword] = useState("")
  const policy = useQuery({ queryKey: ["account-deletion"], queryFn: () => api<DeletionPolicy>("/v1/me/deletion"), staleTime: 0 })
  const remove = useMutation({
    mutationFn: () => api("/v1/me", { method: "DELETE", body: { confirmation: confirmation.trim(), ...(policy.data?.has_password ? { password } : {}) } }),
    onSuccess: () => window.location.assign("/agents/"),
  })
  const cancel = () => { setOpen(false); setConfirmation(""); setPassword(""); remove.reset() }
  const warning = policy.data?.last_account
    ? "This is the only account. Deleting it permanently removes your local account data and saved provider, GitHub and single sign-on connections. This server returns to administrator registration and model setup. This cannot be undone."
    : "This permanently deletes your account, profile photo, sessions, schedules, run history, uploaded images and usage records from this server. Other accounts and work already pushed to GitHub are not deleted. This cannot be undone."
  return <Section title="Delete account" description="Permanently remove your account and its data from this server. Work already pushed to GitHub is not deleted.">
    <div className="flex flex-col gap-3 border-t border-border p-5">
      {policy.data?.blocked_reason && <p className="text-sm text-muted-foreground">{policy.data.blocked_reason}</p>}
      {policy.data?.last_account && <p className="text-sm text-muted-foreground">This is the only account. Deleting it also clears saved connections and returns this server to setup.</p>}
      {policy.isError && <p role="alert" className="text-sm text-failed">Couldn't check account deletion. <button className="text-link" onClick={() => void policy.refetch()}>Try again</button></p>}
      <Button variant="destructive" className="self-start" disabled={!policy.data || !!policy.data.blocked_reason || policy.isFetching || policy.isError} onClick={() => { remove.reset(); setOpen(true); void policy.refetch() }}>Delete account</Button>
    </div>
    <ConfirmDialog open={open} title="Delete your account?" body={warning} confirmLabel={remove.isPending ? "Deleting…" : "Permanently delete account"} busy={remove.isPending} error={remove.error?.message ?? policy.data?.blocked_reason}
      confirmDisabled={confirmation.trim() !== me?.user?.email || !!policy.data?.blocked_reason || policy.isFetching || policy.isError || !!(policy.data?.has_password && !password)} onConfirm={() => remove.mutate()} onCancel={cancel}>
      <FieldGroup className="mt-4">
        <Field><FieldLabel htmlFor="delete-account-email">Type {me?.user?.email} to confirm</FieldLabel><Input id="delete-account-email" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" spellCheck={false} disabled={remove.isPending} /></Field>
        {policy.data?.has_password ? <Field><FieldLabel htmlFor="delete-account-password">Current password</FieldLabel><Input id="delete-account-password" type="password" autoComplete="current-password" maxLength={128} value={password} onChange={e => setPassword(e.target.value)} disabled={remove.isPending} /></Field> : <p className="text-xs text-muted-foreground">For your security, sign in again first if this session is more than 15 minutes old.</p>}
      </FieldGroup>
    </ConfirmDialog>
  </Section>
}
