/** A percentage: "0%", "<0.1%", "3.4%", "37%".  */
export function pct(n: number): string {
  if (n <= 0) return "0%"
  if (n < 0.1) return "<0.1%"
  return n < 10 ? `${n.toFixed(1)}%` : `${Math.round(n)}%`
}

/** Format a currency amount: 3760 → "$37.60". */
export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** "2026-11-01" → "Nov 1" */
export const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })


/** 4m 12s · 1h 03m · 38s */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

/** now · 18m ago · 2h ago · Yesterday · Oct 1 */
export function ago(ts: number, now = Date.now()): string {
  const m = Math.floor((now - ts) / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  if (h < 48) return "Yesterday"
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

export function runElapsed(r: { status: string; created_at: number; started_at: number | null; finished_at: number | null; updated_at: number }, now = Date.now()) {
  if (r.status === "queued") return null
  const start = r.started_at ?? r.created_at
  const end = r.status === "working" ? now : (r.finished_at ?? r.updated_at)
  return duration(end - start)
}

export function initials(name: string | null | undefined, email?: string | null): string {
  const src = (name || email || "?").trim()
  const parts = src.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase()
}

const AVATAR = ["var(--tint-ink)", "var(--info)"]

export function avatarColor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) | 0
  return AVATAR[Math.abs(h) % AVATAR.length]!
}

export function greeting(d = new Date()): string {
  const h = d.getHours()
  return h < 5 ? "Good evening" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"
}

export const repoName = (fullName: string) => fullName.split("/")[1] ?? fullName
