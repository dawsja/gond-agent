import { resolve } from "node:path";
export interface Config {
  data: string;
  origin: string;
  secret: string;
  signup: boolean;
  port: number;
  dockerBin: string;
  workerImage: string;
  maxRuns: number;
  queueMax?: number;
  queueMaxPerAccount?: number;
  queueWaitHours?: number;
  runCPUs: number;
  runMemoryMB: number;
}
export function modelStallMs(): number {
  const minutes = Number(process.env.MODEL_STALL_MINUTES ?? 10);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes * 60_000 > 2_147_483_647)
    throw new Error("Invalid MODEL_STALL_MINUTES");
  return minutes * 60_000;
}
export function failedKeepMs(): number {
  const raw = process.env.GOND_AGENT_FAILED_KEEP_MINUTES ?? "60";
  const minutes = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(minutes) || minutes * 60_000 > 2_147_483_647)
    throw new Error("Invalid GOND_AGENT_FAILED_KEEP_MINUTES");
  return minutes * 60_000;
}
export function idleReleaseMs(): number {
  const raw = process.env.GOND_AGENT_IDLE_RELEASE_SECONDS ?? "120";
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seconds) || seconds > 0xffff_ffff)
    throw new Error("Invalid GOND_AGENT_IDLE_RELEASE_SECONDS");
  return seconds * 1000;
}
export function planSetting(name: "GOND_AGENT_PLAN_REMINDER_EVERY" | "GOND_AGENT_PLAN_NUDGE_LIMIT"): number {
  const fallback = name === "GOND_AGENT_PLAN_REMINDER_EVERY" ? 6 : 2;
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value > 0xffff_ffff) {
    console.warn(`Invalid ${name}; using default ${fallback}.`);
    return fallback;
  }
  return name === "GOND_AGENT_PLAN_NUDGE_LIMIT" ? Math.min(value, 2) : value;
}
export function webSearchLimit(): number {
  const raw = process.env.GOND_AGENT_WEB_SEARCH_LIMIT;
  if (raw === undefined) return 30;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value > 0xffff_ffff) {
    console.warn("Invalid GOND_AGENT_WEB_SEARCH_LIMIT; using default 30.");
    return 30;
  }
  return value;
}
export function questionWaitMinutes(): number {
  const raw = process.env.GOND_AGENT_QUESTION_WAIT_MINUTES;
  if (raw === undefined) return 240;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value > 0xffff_ffff) {
    console.warn("Invalid GOND_AGENT_QUESTION_WAIT_MINUTES; using default 240.");
    return 240;
  }
  return value;
}
export function configFromEnv(): Config {
  modelStallMs();
  failedKeepMs();
  idleReleaseMs();
  webSearchLimit();
  questionWaitMinutes();
  planSetting("GOND_AGENT_PLAN_REMINDER_EVERY");
  planSetting("GOND_AGENT_PLAN_NUDGE_LIMIT");
  const queue = queueSettings();
  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:8787")
    .origin;
  for (const [key, min, max] of [
    ["MAX_ACTIVE_RUNS", 1, 200],
    ["RUN_CPUS", 1, 64],
    ["RUN_MEMORY_MB", 512, 65536],
  ] as const) {
    const n = Number(
      process.env[key] ??
        ({ MAX_ACTIVE_RUNS: 5, RUN_CPUS: 2, RUN_MEMORY_MB: 2048 }[key]),
    );
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`Invalid ${key}`);
  }
  return {
    data: resolve(process.env.GOND_AGENT_DATA_DIR ?? "../data"),
    origin,
    secret,
    signup: process.env.ALLOW_SIGNUP === "true",
    port: Number(process.env.PORT ?? 8787),
    dockerBin: process.env.DOCKER_BIN ?? "docker",
    workerImage: process.env.GOND_AGENT_WORKER_IMAGE ?? "ghcr.io/dawsja/gond-agent-worker:main",
    maxRuns: Number(process.env.MAX_ACTIVE_RUNS ?? 5),
    ...queue,
    runCPUs: Number(process.env.RUN_CPUS ?? 2),
    runMemoryMB: Number(process.env.RUN_MEMORY_MB ?? 2048),
  };
}
export function queueSettings() {
  const read = (name: string, fallback: number) => {
    const raw = process.env[name] ?? String(fallback);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > 0xffff_ffff)
      throw new Error(`Invalid ${name}`);
    return n;
  };
  return {
    queueMax: read("GOND_AGENT_QUEUE_MAX", 50),
    queueMaxPerAccount: read("GOND_AGENT_QUEUE_MAX_PER_ACCOUNT", 10),
    queueWaitHours: read("GOND_AGENT_QUEUE_WAIT_HOURS", 24),
  };
}
