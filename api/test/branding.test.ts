import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "../src/config";
import { MARK_SVG, MARK_INK } from "../../shared/brand-mark";
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

  it("uses Logo C from one source in the workspace and all generated assets", () => {
    expect(createHash("sha256").update(MARK_SVG).digest("hex")).toBe("9812328725e54b0bc4cd4b587968d9fef4a61865aa223f58277e891fc79ec17b");
    expect(MARK_SVG).toContain(`fill="${MARK_INK}"`);
    expect(MARK_SVG).toContain('stroke-opacity="0.22"');
    expect(file("../../web/public/favicon.svg")).toBe(MARK_SVG);
    expect(file("../../shared/logo.tsx")).toContain("MARK_CONTENT");
    execFileSync(process.execPath, ["--import", "tsx", "scripts/build-brand.ts", "--check"], {
      cwd: new URL("..", import.meta.url), stdio: "pipe",
    });
  });

  it("keeps conversation identity independent of models and retired backends", () => {
    const transcript = file("../../web/src/features/run/transcript-view.tsx");
    const label = file("../../web/src/features/run/agent-label.tsx");
    for (const source of [transcript, label]) {
      expect(source).not.toMatch(/\b(ModelMark|ProviderIcon|PROVIDER_LABEL|providerOf|retired_backend)\b/);
    }
    expect(transcript).toMatch(/headings\.has\(it\.key\) && <AgentLabel \/>/);
    expect(label).toContain('<GondAgentMark size={16}');
    expect(label).toContain('data-agent-label');
    expect(label).toContain('aria-label="Gond Agent"');
    expect(label).toContain('<span>Agent</span>');
  });

  it("does not reintroduce the retired mark in tracked source", () => {
    const root = new URL("../../", import.meta.url);
    const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root }).toString().split("\0").filter(Boolean);
    const retired = ["M29 79 " + "A17 17", "CLOUD" + "_PATH", "CLOUD" + "_TRANSFORM"];
    for (const path of new Set(paths)) {
      let bytes: Buffer;
      try { bytes = readFileSync(new URL(path, root)); } catch { continue; }
      if (bytes.includes(0)) continue;
      for (const token of retired) expect(bytes.toString(), path).not.toContain(token);
    }
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
