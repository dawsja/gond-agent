/** Persisted lifecycle states, shared by the service, workspace and MCP. */
export const RUN_STATES = ["queued", "working", "ready", "failed", "stopped", "merged", "interrupted"] as const
export type RunStatus = typeof RUN_STATES[number]

/** Same-state updates are allowed for progress/idempotency, except interrupted:
 * recovery must explicitly re-enter the queue before doing any work.
 */
export const RUN_TRANSITIONS = {
  queued: ["queued", "working", "failed", "stopped", "merged"],
  working: ["working", "queued", "ready", "failed", "stopped", "merged", "interrupted"],
  ready: ["ready", "queued", "working", "failed", "stopped", "merged"],
  failed: ["failed", "queued", "working", "ready", "stopped", "merged"],
  stopped: ["stopped", "queued", "working", "failed", "merged"],
  merged: ["merged"],
  interrupted: ["queued", "stopped", "merged"],
} as const satisfies Record<RunStatus, readonly RunStatus[]>

export function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value)
}

/** Reject lifecycle bugs before changing persisted state. Not a customer error. */
export function assertRunTransition(from: RunStatus, to: RunStatus): void {
  if (!isRunStatus(from) || !(RUN_TRANSITIONS[from] as readonly RunStatus[]).includes(to)) {
    throw new Error(`Illegal run transition: ${from} -> ${to}`)
  }
}
