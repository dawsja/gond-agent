import { readFileSync } from "node:fs";
import { ApiError } from "./wire";

type ModelPolicy = { retryable: boolean; message: string };

function loadModelErrors(): Readonly<Record<string, ModelPolicy>> {
  const table: unknown = JSON.parse(readFileSync(new URL("../../runner/model-errors.json", import.meta.url), "utf8"));
  if (!table || typeof table !== "object" || Array.isArray(table) || !Object.hasOwn(table, "unknown")) {
    throw new Error("Invalid model error policy: expected a class table with an unknown fallback");
  }
  for (const [code, policy] of Object.entries(table)) {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)
      || typeof policy.retryable !== "boolean" || typeof policy.message !== "string" || !policy.message.trim()) {
      throw new Error(`Invalid model error policy for class ${code}: expected retryable and message`);
    }
  }
  return table as Record<string, ModelPolicy>;
}

/** Shared with the compiled worker; no provider prose is a public failure reason. */
export const modelErrors = loadModelErrors();
export function modelPolicy(code: unknown) {
  const key = typeof code === "string" && Object.hasOwn(modelErrors, code) ? code : "unknown";
  return { code: key, ...modelErrors[key] };
}
export function modelFailure(status: number, code: string): ApiError {
  const policy = modelPolicy(code);
  return new ApiError(status, policy.code, policy.message, policy.retryable);
}
export function modelReason(code: unknown, status?: unknown, resetAt?: unknown): string {
  const policy = modelPolicy(code);
  const http = Number.isInteger(status) && Number(status) >= 400 && Number(status) <= 599 ? ` HTTP ${status}.` : "";
  const reset = ["chatgpt_usage_limit", "provider_usage_limit"].includes(policy.code) && typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0 && resetAt < 253402300800
    ? ` The limit resets at ${new Date(resetAt * 1000).toISOString()}.` : "";
  return policy.message + http + reset;
}
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const delay = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(120_000, Math.ceil(delay)) : undefined;
}
