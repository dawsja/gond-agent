import { useLayoutEffect } from "react"
import { Navigate, useLocation, useNavigate } from "react-router"
import { SettingsScreen } from "@/features/settings/settings-screen"
import { resolveSettingsLocation } from "@/features/settings/registry"
import { useMe } from "@/lib/queries"

export function SettingsRoute() {
  const { pathname, hash, search } = useLocation()
  const navigate = useNavigate(), { data: me } = useMe()
  const resolved = resolveSettingsLocation(pathname, hash, search, !!me?.admin)
  useLayoutEffect(() => {
    if (me && !resolved.external && resolved.to !== pathname + search + hash) navigate(resolved.to, { replace: true })
  }, [me, resolved.external, resolved.to, pathname, search, hash, navigate])
  // GitHub bookmarks leave before any Settings forms mount. Local compatibility
  // links retain the same screen instance, so redirects cannot discard drafts.
  if (resolved.external) return <Navigate to={resolved.to} replace />
  if (!me) return null
  return <SettingsScreen page={resolved.page} />
}
