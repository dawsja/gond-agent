import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config";

const file = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

afterEach(() => vi.unstubAllEnvs());

describe("Gond Agent identity", () => {
  it("uses product-scoped deployment settings", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "test-only-secret-with-at-least-32-characters");
    vi.stubEnv("GOND_AGENT_DATA_DIR", "/tmp/gond-agent-branding");
    vi.stubEnv("GOND_AGENT_WORKER_IMAGE", "gond-agent-worker:fixture");
    const config = configFromEnv();
    expect(config.data).toBe("/tmp/gond-agent-branding");
    expect(config.workerImage).toBe("gond-agent-worker:fixture");
  });

  it("keeps worker installation and launch paths aligned", () => {
    const docker = file("../../Dockerfile");
    const worker = file("../../containers/agent.py");
    const cargo = file("../../runner/Cargo.toml");
    expect(cargo.match(/^name = "gond-agent-worker"$/gm)).toHaveLength(2);
    expect(docker).toContain("/src/target/release/gond-agent-worker /usr/local/bin/gond-agent-worker");
    expect(worker).toContain('"/usr/local/bin/gond-agent-worker"');
    expect(worker).toContain('"GOND_AGENT_API_URL"');
    expect(file("../../runner/src/main.rs")).toContain('std::env::var("GOND_AGENT_API_URL")');
    expect(docker).toContain("HOME=/home/gond-agent");
    expect(file("../src/containers.ts")).toContain('"/home/gond-agent:rw,');
  });

  it("uses the canonical faceless cloud in both frontends", () => {
    const canonical = file("../../shared/brand-mark.ts").match(/CLOUD_PATH = "([^"]+)"/)![1];
    expect(canonical).toBe("M29 79 A17 17 0 0 1 26.46 45.19 A3 3 0 0 0 29.01 42.32 A21 21 0 0 1 70.55 38.67 A3 3 0 0 0 73.28 41.04 A19 19 0 0 1 72 79 Z");
    const site = file("../../site/public/favicon.svg");
    const transform = file("../../shared/brand-mark.ts").match(/CLOUD_TRANSFORM = "([^"]+)"/)![1];
    expect(site).toContain(`transform="${transform}"`);
    expect(site).toBe(file("../../web/public/favicon.svg"));
    expect(site).toContain(`d="${canonical}"`);
    expect(site).toContain('fill="#1b1a18" stroke="#1b1a18"');
    expect(site.match(/<circle\b/g)).toHaveLength(1);
    expect(site.match(/<path\b/g)).toHaveLength(1);
    expect(site).not.toMatch(/<rect\b|<animate\b/);
    expect(file("../../shared/logo.tsx")).toContain("d={CLOUD_PATH}");
  });

  it("defines a self-hosted Compose project instead of inheriting the checkout name", () => {
    const compose = file("../../docker-compose.yml");
    expect(compose).toMatch(/^name: gond-agent$/m);
    expect(compose).toContain("GOND_AGENT_WORKER_IMAGE:");
    expect(compose).toContain("source: gond-agent-data");
    expect(file("../../shared/brand.ts")).toContain('HELP_EMAIL = "hi@gond.io"');
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

  it("describes container execution consistently in the workspace", () => {
    for (const path of ["home/home-screen.tsx", "run/run-screen.tsx"])
      expect(file(`../../web/src/features/${path}`)).toContain("Its worker container is removed.");
    expect(file("../../web/src/features/home/home-screen.tsx")).toContain("Waiting for a worker");
    expect(file("../../web/src/features/automations/runners.tsx")).toContain("Each run starts in its own worker container.");
    expect(file("../../web/src/features/run/side-panel.tsx")).toContain("GitHub isn't connected, so the changes weren't pushed.");
    expect(file("../../web/src/features/studio/composer.tsx")).toContain("container-backed runs");
    expect(file("../../web/src/lib/api.ts")).toContain("what its worker container is doing");
  });
});
