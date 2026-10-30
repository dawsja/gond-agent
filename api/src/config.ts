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
  idleMs: number;
  turnMs: number;
}
export function configFromEnv(): Config {
  const secret = process.env.BETTER_AUTH_SECRET ?? "";
  if (secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const origin = new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:8787")
    .origin;
  for (const [key, min, max] of [
    ["MAX_ACTIVE_RUNS", 1, 200],
    ["RUN_IDLE_MINUTES", 1, 1440],
    ["RUN_TURN_MINUTES", 1, 1440],
    ["RUN_CPUS", 1, 64],
    ["RUN_MEMORY_MB", 512, 65536],
  ] as const) {
    const n = Number(
      process.env[key] ??
        ({ MAX_ACTIVE_RUNS: 5, RUN_IDLE_MINUTES: 30, RUN_TURN_MINUTES: 60, RUN_CPUS: 2, RUN_MEMORY_MB: 2048 }[key]),
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
    workerImage: process.env.GOND_AGENT_WORKER_IMAGE ?? "gond-agent-worker:local",
    maxRuns: Number(process.env.MAX_ACTIVE_RUNS ?? 5),
    runCPUs: Number(process.env.RUN_CPUS ?? 2),
    runMemoryMB: Number(process.env.RUN_MEMORY_MB ?? 2048),
    idleMs: Number(process.env.RUN_IDLE_MINUTES ?? 30) * 60_000,
    turnMs: Number(process.env.RUN_TURN_MINUTES ?? 60) * 60_000,
  };
}
