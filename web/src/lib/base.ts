// The self-hosted workspace mount comes from Vite's `base`, so routing and asset URLs agree.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, "")

/** An app path ("/sign-in") as a URL path on this origin ("/agents/sign-in"). */
export const appUrl = (path: string) => BASE + path

/** The current URL path inside the app, without the base ("/agents/runs/x" → "/runs/x"). */
export function appPath(pathname = location.pathname): string {
  if (!BASE) return pathname
  if (pathname === BASE) return "/"
  return pathname.startsWith(BASE + "/") ? pathname.slice(BASE.length) : pathname
}
