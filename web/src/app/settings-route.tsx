import { Navigate, useLocation } from "react-router"
import { SettingsScreen } from "@/features/settings/settings-screen"

// The retired Connections category only contained GitHub. Redirect before
// mounting Settings so old bookmarks never mount connection controls there.
const githubTargets = new Set(["connections", "connections-settings", "github", "shared-github"])

export function SettingsRoute() {
  const { pathname, hash, search } = useLocation()
  const query = new URLSearchParams(search)
  const targets = [hash.slice(1), pathname.split("/")[2], ...["section", "tab", "anchor"].map(key => query.get(key))]
  if (targets.some(target => target && githubTargets.has(target.toLowerCase()))) return <Navigate to="/plugins/github" replace />
  return <SettingsScreen />
}
