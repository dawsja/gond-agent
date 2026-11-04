/** Public checkpoint diagnostics: never derive reasons from exception text or private state. */
export const CHECKPOINT_FAILURE_REASONS = [
  "tree_too_large", "state_too_large", "storage_limit", "timeout",
  "background_shells_active", "staged_ignored_files", "busy", "worker_unavailable",
  "invalid_state", "git_failed", "storage_failed", "unknown",
] as const;
export type CheckpointFailureReason = typeof CHECKPOINT_FAILURE_REASONS[number];
export function isCheckpointFailureReason(value: unknown): value is CheckpointFailureReason {
  return typeof value === "string" && (CHECKPOINT_FAILURE_REASONS as readonly string[]).includes(value);
}
export class CheckpointCaptureError extends Error {
  constructor(readonly reason: CheckpointFailureReason, message = "Workspace checkpoint unavailable.") {
    super(message);
  }
}
export function checkpointFailureReason(error: unknown): CheckpointFailureReason {
  if (error instanceof CheckpointCaptureError) return isCheckpointFailureReason(error.reason) ? error.reason : "unknown";
  // Only fixed OS codes, never paths or messages, can identify host persistence failures.
  if (error instanceof Error && "code" in error && ["ENOSPC", "EDQUOT", "EACCES", "EROFS", "EIO"].includes(String(error.code)))
    return "storage_failed";
  return "unknown";
}
