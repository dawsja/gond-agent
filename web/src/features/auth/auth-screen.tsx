import { useState, type FormEvent } from "react"
import { useQuery } from "@tanstack/react-query"
import { authClient } from "@/lib/auth-client"
import { api } from "@/lib/api"
import { Button } from "@shared/ui/button"
import { Input } from "@shared/ui/input"
import { Field, FieldGroup, FieldLabel } from "@shared/ui/field"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@shared/ui/card"
import { GondAgentMark } from "@shared/logo"

interface Bootstrap { firstAccount: boolean; signupAllowed: boolean; providers: { id: string; name: string }[] }

export function AuthScreen() {
  const [signup, setSignup] = useState(false), [email, setEmail] = useState(""), [password, setPassword] = useState(""), [name, setName] = useState("")
  const [busy, setBusy] = useState(false), [error, setError] = useState("")
  const bootstrap = useQuery({ queryKey: ["auth-bootstrap"], queryFn: () => api<Bootstrap>("/auth/bootstrap"), staleTime: 0 })
  const firstAccount = bootstrap.data?.firstAccount ?? false
  const registering = firstAccount || (signup && !!bootstrap.data?.signupAllowed)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("")
    try {
      const result = registering ? await authClient.signUp.email({ email, password, name }) : await authClient.signIn.email({ email, password })
      if (result.error) setError(result.error.message ?? "Couldn't sign in. Check your details and try again.")
      else window.location.assign("/agents/")
    } catch { setError("Couldn't reach Gond Agent. Try again.") } finally { setBusy(false) }
  }
  return <main className="grid min-h-screen place-items-center bg-background px-5 text-foreground">
    <Card className="w-full max-w-sm"><CardHeader>
      <GondAgentMark className="mb-6 size-10" />
      <CardTitle className="text-2xl">{bootstrap.isPending ? "Gond Agent" : firstAccount ? "Create the administrator account" : registering ? "Create your account" : "Sign in to Gond Agent"}</CardTitle>
      <CardDescription>{firstAccount ? "This is the first account on this server. Next, connect a model provider to open your workspace." : "Your coding workspace, on your own server."}</CardDescription></CardHeader><CardContent>
      {bootstrap.isPending ? <p role="status" className="text-sm text-muted-foreground">Checking this instance…</p> : bootstrap.isError ? <div className="flex flex-col gap-3"><p role="alert" className="text-sm text-failed">{bootstrap.error.message}</p><Button variant="outline" onClick={() => void bootstrap.refetch()}>Try again</Button></div> : <>
      <form onSubmit={e => void submit(e)}><FieldGroup>
        {registering && <Field><FieldLabel>Name<Input required maxLength={100} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></FieldLabel></Field>}
        <Field><FieldLabel>Email<Input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></FieldLabel></Field>
        <Field><FieldLabel>Password<Input required type="password" minLength={registering ? 12 : undefined} maxLength={128} autoComplete={registering ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} /></FieldLabel></Field>
        {registering && <p className="text-xs text-muted-foreground">{firstAccount ? "Use at least 12 characters. This account manages instance settings." : "Use at least 12 characters. Registration is controlled by your administrator."}</p>}
        {error && <p role="alert" className="text-sm text-failed">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? "Please wait…" : firstAccount ? "Create administrator account" : registering ? "Create account" : "Sign in"}</Button>
      </FieldGroup></form>
      {bootstrap.data.providers.map(p => <Button variant="outline" key={p.id} disabled={busy} onClick={() => { setBusy(true); void authClient.signIn.social({ provider: p.id, callbackURL: "/agents/" }).then(r => { if (r.error) setError("Single sign-on is unavailable. Try again or use your password."); setBusy(false) }).catch(() => { setError("Single sign-on is unavailable."); setBusy(false) }) }} className="mt-3 w-full">Continue with {p.name}</Button>)}
      {!firstAccount && bootstrap.data.signupAllowed && <Button variant="link" onClick={() => { setSignup(!signup); setError("") }} className="mt-5 text-sm text-link">{registering ? "Already have an account? Sign in" : "Create an account"}</Button>}
      </>}
    </CardContent></Card>
  </main>
}
