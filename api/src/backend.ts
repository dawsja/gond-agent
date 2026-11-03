import { ApiError } from "./wire";

/** Every run uses the built-in Rust runner. This type intentionally has one member. */
export const BACKEND = "builtin" as const;
export type Backend = typeof BACKEND;

/** Rejects any request or record that names a coding agent other than the built-in runner. */
export function assertBackend(value: unknown): Backend {
  if (value === undefined || value === BACKEND) return BACKEND;
  throw new ApiError(400, "invalid_backend", "Gond Agent runs every session with its built-in agent. Remove the backend option and choose a model.");
}

/** Runs created by the removed Claude Code and Codex agents keep their history but take no new work. */
export function assertActive(run: { retired_backend?: string }) {
  if (run.retired_backend)
    throw new ApiError(409, "retired_backend", "This session used a coding agent that is no longer available. Its history and diff stay readable; start a new session to continue.");
}

export const RETIRED_MODEL_PREFIX = "cli-";
