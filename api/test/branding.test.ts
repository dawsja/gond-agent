import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config";
import { CLOUD_PATH, CLOUD_TRANSFORM, MARK_INK } from "../../shared/brand-mark";
import { HELP_EMAIL } from "../../shared/brand";

const file = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

afterEach(() => vi.unstubAllEnvs());

describe("Gond Agent identity", () => {
  it("uses product-scoped deployment settings", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-only-secret-with-at-least-32-characters");
    const data = join(tmpdir(), "gond-agent-branding");
    vi.stubEnv("GOND_AGENT_DATA_DIR", data);
    vi.stubEnv("GOND_AGENT_WORKER_IMAGE", "gond-agent-worker:fixture");
    const config = configFromEnv();
    expect(config.data).toBe(data);
    expect(config.workerImage).toBe("gond-agent-worker:fixture");
  });

  it("uses the canonical faceless cloud in both frontends", () => {
    const site = file("../../site/public/favicon.svg");
    expect(site).toContain(`transform="${CLOUD_TRANSFORM}"`);
    expect(site).toBe(file("../../web/public/favicon.svg"));
    expect(site).toContain(`d="${CLOUD_PATH}"`);
    expect(site).toContain(`fill="${MARK_INK}" stroke="${MARK_INK}"`);
    expect(site.match(/<circle\b/g)).toHaveLength(1);
    expect(site.match(/<path\b/g)).toHaveLength(1);
    expect(site).not.toMatch(/<rect\b|<animate\b/);
  });

  it("defines a self-hosted Compose project instead of inheriting the checkout name", () => {
    const compose = file("../../docker-compose.yml");
    expect(compose).toMatch(/^name: gond-agent$/m);
    expect(compose).toContain("GOND_AGENT_WORKER_IMAGE:");
    expect(compose).toContain("source: gond-agent-data");
    expect(HELP_EMAIL).toBe("hi@gond.io");
  });

  it("defaults to published images without hiding the worker from ordinary pulls", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-only-secret-with-at-least-32-characters");
    vi.stubEnv("GOND_AGENT_WORKER_IMAGE", undefined);
    expect(configFromEnv().workerImage).toBe("ghcr.io/dawsja/gond-agent-worker:main");
    const compose = file("../../docker-compose.yml");
    expect(compose).toContain("${GOND_AGENT_IMAGE:-ghcr.io/dawsja/gond-agent:main}");
    expect(compose.match(/\$\{GOND_AGENT_WORKER_IMAGE:-ghcr.io\/dawsja\/gond-agent-worker:main\}/g)).toHaveLength(2);
    expect(compose).not.toMatch(/^\s+(build|profiles):/m);
    expect(compose).toContain('entrypoint: ["/usr/bin/true"]');
    expect(compose).toContain("condition: service_completed_successfully");
    expect(file("../../.env.example")).toContain("GOND_AGENT_IMAGE=ghcr.io/dawsja/gond-agent:main");
    expect(file("../../.env.example")).toContain("GOND_AGENT_WORKER_IMAGE=ghcr.io/dawsja/gond-agent-worker:main");
    const build = file("../../docker-compose.build.yml");
    expect(build).toContain("target: runtime");
    expect(build).toContain("target: worker-image");
    expect(build).toContain("GOND_AGENT_WORKER_IMAGE: gond-agent-worker:local");
  });
});
