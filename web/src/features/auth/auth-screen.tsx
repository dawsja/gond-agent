import { useEffect, useState, type FormEvent } from "react"
import { authClient } from "@/lib/auth-client"
import { Button } from "@shared/ui/button"
import { Input } from "@shared/ui/input"
import { Field, FieldGroup, FieldLabel } from "@shared/ui/field"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@shared/ui/card"
import { GondAgentMark } from "@shared/logo"
export function AuthScreen() {
  const [signup, setSignup] = useState(false), [email, setEmail] = useState(""), [password, setPassword] = useState(""), [name, setName] = useState("")
  const [busy, setBusy] = useState(false), [error, setError] = useState("")
  const [providers, setProviders] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { void fetch("/api/auth/providers").then(r => r.json()).then(r => setProviders(r.providers)).catch(() => {}) }, [])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("")
    try {
      const result = signup ? await authClient.signUp.email({ email, password, name }) : await authClient.signIn.email({ email, password })
      if (result.error) setError(result.error.message ?? "Couldn't sign in. Check your details and try again.")
      else window.location.assign("/agents/")
    } catch { setError("Couldn't reach Gond Agent. Try again.") } finally { setBusy(false) }
  }
  return <main className="grid min-h-screen place-items-center bg-background px-5 text-foreground">
    <Card className="w-full max-w-sm"><CardHeader>
      <GondAgentMark className="mb-6 size-10" />
      <CardTitle className="text-2xl">{signup ? "Create your account" : "Sign in to Gond Agent"}</CardTitle>
      <CardDescription>Your coding workspace, on your own server.</CardDescription></CardHeader><CardContent>
      <form onSubmit={e => void submit(e)}><FieldGroup>
        {signup && <Field><FieldLabel>Name<Input required maxLength={100} autoComplete="name" value={name} onChange={e => setName(e.target.value)} /></FieldLabel></Field>}
        <Field><FieldLabel>Email<Input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></FieldLabel></Field>
        <Field><FieldLabel>Password<Input required type="password" minLength={signup ? 12 : undefined} maxLength={128} autoComplete={signup ? "new-password" : "current-password"} value={password} onChange={e => setPassword(e.target.value)} /></FieldLabel></Field>
        {signup && <p className="text-xs text-muted-foreground">Use at least 12 characters. Registration is controlled by your administrator.</p>}
        {error && <p role="alert" className="text-sm text-failed">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</Button>
      </FieldGroup></form>
      {providers.map(p => <Button variant="outline" key={p.id} disabled={busy} onClick={() => { setBusy(true); void authClient.signIn.social({ provider: p.id, callbackURL: "/agents/" }).then(r => { if (r.error) setError("Single sign-on is unavailable. Try again or use your password."); setBusy(false) }).catch(() => { setError("Single sign-on is unavailable."); setBusy(false) }) }} className="mt-3 w-full">Continue with {p.name}</Button>)}
      <Button variant="link" onClick={() => { setSignup(!signup); setError("") }} className="mt-5 text-sm text-link">{signup ? "Already have an account? Sign in" : "Create an account"}</Button>
    </CardContent></Card>
  </main>
}
