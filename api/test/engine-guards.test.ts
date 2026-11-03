import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
function sources(path: string): string[] {
  return readdirSync(join(root, path), {withFileTypes:true}).flatMap(entry =>
    entry.isDirectory() ? sources(`${path}/${entry.name}`) : /\.(ts|rs|py|mjs)$/.test(entry.name) && !entry.name.startsWith("test_") ? [`${path}/${entry.name}`] : []);
}
it("keeps publication identity centralized and free of fixed product authors", () => {
  for (const path of [...sources("api/src"), ...sources("runner/src"), "containers/agent.py"]) {
    const source = read(path);
    expect(source, path).not.toMatch(/agent@localhost|user\.name[="\s,]+Gond Agent/);
    if (/"commit",\s*"-m"/.test(source)) {
      expect(path).toBe("containers/agent.py");
      expect(source).toContain('req.get("identity", {})');
      expect(source).toContain('env=env');
    }
  }
  expect(read("api/src/github.ts")).toContain("const identity = await commitIdentity(env)");
  expect(read("api/src/runs/service.ts")).toContain("identity: await commitIdentity(githubEnvFor(this.db, this.cfg.secret, r.user_id))");
});
it("keeps elapsed-time teardown out of the run pump and removes the completion gate", () => {
  const service = read("api/src/runs/service.ts");
  const pump = service.slice(service.indexOf("private async pump"), service.indexOf("private async finish"));
  expect(pump).not.toMatch(/Date\.now\(\)\s*[-<>]|this\.close|this\.stop/);
  expect(read("api/src/config.ts")).not.toMatch(/idleMs|turnMs|RUN_IDLE_MINUTES|RUN_TURN_MINUTES/);
  for (const path of ["runner/src/agent/core.rs"]) {
    expect(read(path)).not.toMatch(/finish_review|gond-reviewed|check-review|require_review/);
  }
});
