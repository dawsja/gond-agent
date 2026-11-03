import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { planSetting } from "../src/config";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it.each(["GOND_AGENT_PLAN_REMINDER_EVERY", "GOND_AGENT_PLAN_NUDGE_LIMIT"] as const)("validates %s without failing runs or logging values", name => {
  const fallback = name === "GOND_AGENT_PLAN_REMINDER_EVERY" ? 6 : 2;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv(name, undefined);
  expect(planSetting(name)).toBe(fallback);
  for (const raw of ["garbage-private-value", "-1", "1.5", "", " 2", "2e1", "4294967296"]) {
    vi.stubEnv(name, raw);
    expect(planSetting(name)).toBe(fallback);
    expect(warn).toHaveBeenLastCalledWith(`Invalid ${name}; using default ${fallback}.`);
  }
  vi.stubEnv(name, "0"); expect(planSetting(name)).toBe(0);
  vi.stubEnv(name, "8"); expect(planSetting(name)).toBe(name === "GOND_AGENT_PLAN_NUDGE_LIMIT" ? 2 : 8);
});

it("passes plan controls through the default Compose service environment", () => {
  const compose = readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8");
  const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
  for (const [name, fallback] of [["GOND_AGENT_PLAN_REMINDER_EVERY", 6], ["GOND_AGENT_PLAN_NUDGE_LIMIT", 2]]) {
    expect(compose).toContain(`${name}: "\${${name}:-${fallback}}"`);
    expect(example).toContain(`${name}=${fallback}`);
  }
});
