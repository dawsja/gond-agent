import type { Run } from "./service";
import type { Capacity } from "../wire";
export type { Capacity } from "../wire";

/** A verified worker observation, never inferred from the API checkout or pushed flag. */
export interface WorkspaceState { head: string; clean: boolean }
export interface ReleaseCandidate {
  run: Pick<Run, "status" | "phase" | "pending" | "summary" | "pushed" | "head_sha" | "base_sha" | "work_kept" | "kept_commit" | "pr_state" | "auto_resume_pending" | "resume_from_checkpoint" | "recovery_phase">;
  live: boolean;
  busy: boolean;
  closing: boolean;
  booting: boolean;
  publicationPending: boolean;
  checkpointClaimed: boolean;
  idleSince?: number;
  delayMs: number;
  state?: WorkspaceState;
}

/** The counter and releaser must agree; unknown/unsafe evidence always fails closed. */
export function releasable(candidate: ReleaseCandidate, now: number): boolean {
  const { run, state } = candidate;
  // Clean alone does not rule out unpublished commits. A never-pushed stopped
  // checkout is untouched only when its HEAD still equals the pinned base.
  const savedHead = run.pushed ? run.head_sha : run.status === "stopped" && !run.head_sha ? run.base_sha : null;
  return candidate.delayMs > 0 && candidate.live && !candidate.busy && !candidate.closing && !candidate.booting &&
    !candidate.publicationPending && !candidate.checkpointClaimed && candidate.idleSince !== undefined && now - candidate.idleSince >= candidate.delayMs &&
    ["ready", "stopped"].includes(run.status) && ["agent", "idle"].includes(run.phase) && !run.pending.length && !run.summary.question &&
    !run.auto_resume_pending && !run.resume_from_checkpoint && !run.recovery_phase &&
    !run.work_kept && !run.kept_commit && !!savedHead && state?.clean === true && state.head === savedHead;
}

export function capacityReason(capacity: Capacity): string {
  const { max, occupied, working } = capacity;
  const idle = occupied - working;
  if (occupied >= max)
    return `All ${max} ${max === 1 ? "workspace is" : "workspaces are"} in use: ${working} working, ${idle} idle. Idle workspaces can be closed to free a slot.`;
  return "Waiting for a workspace to start. Work starts in account queue order as capacity becomes available.";
}
