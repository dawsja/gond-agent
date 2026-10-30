// Typed client for the self-hosted server. Everything goes through the same origin: `/api/*` and
// `/ws/*` (under the app's base path) are forwarded to the API (Vite proxy locally, a service binding
// when deployed).


export type RunStatus = "queued" | "working" | "ready" | "merged" | "failed" | "stopped"

export interface Run {
  id: string
  user_id: string
  user_name?: string | null
  repo: string
  base_branch: string
  branch: string
  model_id: string
  title: string
  prompt: string
  status: RunStatus
  step: string | null
  plan_done: number
  plan_total: number
  files: number
  additions: number
  deletions: number
  pr_number: number | null
  pr_url: string | null
  pr_state: "open" | "closed" | "merged" | null
  checks: "pending" | "success" | "failure" | null
  error: string | null
  /** Where it was started; `issue`: from a labeled GitHub issue (Automations). */
  source?: "web" | "issue" | "runner" | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  updated_at: number
  /** On a single run: what its worker container is doing (`agent`: up, with the agent ready for a message). */
  live?: { phase: "idle" | "booting" | "agent" | "finishing"; pushed?: boolean }
}

export interface Me {
  admin?: boolean
  user: { id: string; email: string | null; name: string | null } | null
  setup_required: boolean
  /**
   * The Automations page: labeled issues start runs and failing checks go back to the run (both start off);
   * auto_pr opens the pull request when a turn ends (starts on; off, you create it from the run).
   */
  automations?: { issue_runs: boolean; fix_checks: boolean; auto_pr: boolean }
}

/** A saved prompt that starts a fresh run on a schedule (Automations → Gond Agent Runners). */
export interface Runner {
  id: string
  name: string
  repo: string
  base_branch: string | null
  model_id: string
  prompt: string
  frequency: "daily" | "weekly"
  /** Monday = 0 … Sunday = 6. Empty for a daily schedule. */
  weekdays: number[]
  /** Minutes after local midnight. */
  minute: number
  timezone: string
  enabled: boolean
  next_run_at: number | null
  /** The last scheduled time: the run it started, or why it skipped or couldn't start one. */
  last: { at: number; status: "claimed" | "started" | "skipped" | "failed"; reason: string | null; run_id: string | null } | null
  created_at: number
  updated_at: number
}

export interface Model {
  id: string
  provider: string
  display_name: string
  context_window: number
  connection_id?: string
  connection_name?: string
}

export interface ModelCatalog { models: Model[]; connections: { id: string; name: string; status: "ready" | "empty" | "unsupported" | "error"; message?: string }[] }

export interface Repo {
  full_name: string
  private: boolean
  default_branch: string
  pushed_at: string | null
}

export interface GithubStatus { configured: boolean; login: string | null; managed: boolean }
export interface GithubLogin { id?: string; status: "idle" | "starting" | "pending" | "connected" | "expired" | "cancelled" | "error" | "busy"; code?: string; url?: string; expiresAt?: number; message?: string }

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** For responses without an API error body (a proxy page, an outage). */
function statusMessage(status: number): string {
  if (status === 401) return "You're signed out. Sign in again."
  if (status === 403) return "You don't have access to that."
  if (status === 404) return "That doesn't exist anymore."
  if (status === 429) return "Gond Agent is busy right now. Try again in a moment."
  if (status >= 500) return "Gond Agent is having trouble right now. Try again in a moment."
  return "Something went wrong. Try again."
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; upload?: Blob; text?: boolean; blob?: boolean } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      credentials: "same-origin",
      method: init.method ?? (init.body === undefined && !init.upload ? "GET" : "POST"),
      headers: {
        ...(init.upload ? { "content-type": init.upload.type } : init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.upload ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    })
  } catch {
    throw new ApiError(0, "network", "Can't reach Gond Agent. Check your internet connection and try again.")
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    throw new ApiError(res.status, body?.error?.code ?? "http_error", body?.error?.message ?? statusMessage(res.status))
  }
  return (init.text ? await res.text() : init.blob ? await res.blob() : await res.json()) as T
}

/** A run's live socket: a one-time ticket from the API opens it (a session token never goes in a URL). */
export async function runSocketUrl(id: string, after: number): Promise<string> {
  const { ticket } = await api<{ ticket: string }>(`/v1/runs/${id}/ticket`, { method: "POST" })
  const q = new URLSearchParams({ ticket, after: String(after) })
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/runs/${id}?${q}`
}
