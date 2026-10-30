import type { ReactNode } from "react"
import { useMe } from "@/lib/queries"
import { useSession } from "@/app/auth"
import { ProviderSettings } from "../settings/providers"

export function SetupGate({ children }: { children: ReactNode }) {
  const query = useMe(), session = useSession()
  if (query.isPending) return <div className="grid min-h-screen place-items-center">Loading your workspace…</div>
  if (query.isError) return <div className="grid min-h-screen place-items-center p-6"><div className="flex flex-col gap-4"><p role="alert">{query.error.message}</p><button className="text-sm text-link" onClick={() => void query.refetch()}>Try again</button></div></div>
  if (!query.data.setup_required) return children
  return <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-8"><div className="mx-auto max-w-[760px] flex flex-col gap-5">
    <div className="flex items-center justify-between gap-4"><span className="text-sm font-semibold">Gond Agent</span><button className="text-sm text-link" onClick={() => void session.signOut()}>Sign out</button></div>
    <h1 className="text-3xl font-semibold">Set up Gond Agent</h1>
    {query.data.admin ? <><p className="text-sm text-muted-foreground">Your account is ready. Connect a model provider and choose a default model to open the workspace. You can change these settings later.</p><ProviderSettings setup /></> : <p role="status" className="text-sm text-muted-foreground">An administrator needs to connect a model provider before this workspace is ready. This page updates when setup is complete.</p>}
  </div></main>
}
