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
  runCPUs: number;
  runMemoryMB: number;
}
export function modelStallMs(): number {
  const minutes = Number(process.env.MODEL_STALL_MINUTES ?? 10);
  if (!Number.isFinite(minutes) || minutes < 0 || minutes * 60_000 > 2_147_483_647)
    throw new Error("Invalid MODEL_STALL_MINUTES");
  return minutes * 60_000;
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
export function configFromEnv(): Config {
  modelStallMs();
  planSetting("GOND_AGENT_PLAN_REMINDER_EVERY");
  planSetting("GOND_AGENT_PLAN_NUDGE_LIMIT");
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
    runCPUs: Number(process.env.RUN_CPUS ?? 2),
    runMemoryMB: Number(process.env.RUN_MEMORY_MB ?? 2048),
  };
}
