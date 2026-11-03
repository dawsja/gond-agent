import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { planSetting, webSearchLimit, questionWaitMinutes } from "../src/config";

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

it("validates the web search limit strictly and exposes the default through Compose", () => {
  const name = "GOND_AGENT_WEB_SEARCH_LIMIT";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv(name, undefined); expect(webSearchLimit()).toBe(30);
  for (const raw of ["private-invalid", "-1", "1.5", "", " 2", "2e1", "4294967296"]) {
    vi.stubEnv(name, raw); expect(webSearchLimit()).toBe(30);
    expect(warn).toHaveBeenLastCalledWith("Invalid GOND_AGENT_WEB_SEARCH_LIMIT; using default 30.");
  }
  vi.stubEnv(name, "0"); expect(webSearchLimit()).toBe(0);
  vi.stubEnv(name, "8"); expect(webSearchLimit()).toBe(8);
  expect(readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8")).toContain('GOND_AGENT_WEB_SEARCH_LIMIT: "${GOND_AGENT_WEB_SEARCH_LIMIT:-30}"');
  expect(readFileSync(new URL("../../.env.example", import.meta.url), "utf8")).toContain("GOND_AGENT_WEB_SEARCH_LIMIT=30");
});

it("validates question waiting minutes and passes its default through Compose", () => {
  const name = "GOND_AGENT_QUESTION_WAIT_MINUTES";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv(name, undefined); expect(questionWaitMinutes()).toBe(240);
  for (const raw of ["private-invalid", "-1", "1.5", "", " 2", "2e1", "4294967296"]) {
    vi.stubEnv(name, raw); expect(questionWaitMinutes()).toBe(240);
    expect(warn).toHaveBeenLastCalledWith("Invalid GOND_AGENT_QUESTION_WAIT_MINUTES; using default 240.");
  }
  vi.stubEnv(name, "0"); expect(questionWaitMinutes()).toBe(0);
  vi.stubEnv(name, "8"); expect(questionWaitMinutes()).toBe(8);
  expect(readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8")).toContain('GOND_AGENT_QUESTION_WAIT_MINUTES: "${GOND_AGENT_QUESTION_WAIT_MINUTES:-240}"');
  expect(readFileSync(new URL("../../.env.example", import.meta.url), "utf8")).toContain("GOND_AGENT_QUESTION_WAIT_MINUTES=240");
});
