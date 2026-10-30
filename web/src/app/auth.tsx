import { createContext, type ReactNode, useContext } from "react"
import { authClient } from "@/lib/auth-client"
import { AuthScreen } from "@/features/auth/auth-screen"
interface Session { mode: "local"; imageUrl?: string; signOut: () => Promise<void> }
const SessionContext = createContext<Session>({ mode: "local", signOut: async () => { await authClient.signOut() } })
export const useSession = () => useContext(SessionContext)
export function AuthGate({ children }: { children: ReactNode }) {
  const { data, isPending } = authClient.useSession()
  if (isPending) return <div className="grid min-h-screen place-items-center bg-background text-foreground">Loading…</div>
  if (!data) return <AuthScreen />
  return <SessionContext.Provider value={{ mode: "local", imageUrl: data.user.image ?? undefined, signOut: async () => { await authClient.signOut(); window.location.assign("/agents/") } }}>{children}</SessionContext.Provider>
}
