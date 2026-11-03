import { existsSync, readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the standalone frontend out of the repository", () => {
  expect(existsSync(new URL("../../site/", import.meta.url))).toBe(false);
});

it("keeps the standalone frontend out of CI jobs and matrices", () => {
  const workflows = new URL("../../.github/workflows/", import.meta.url);
  for (const name of readdirSync(workflows).filter(name => /\.ya?ml$/.test(name))) {
    const workflow = readFileSync(new URL(name, workflows), "utf8");
    expect(workflow, name).not.toMatch(/\bsite\b/);
  }
});
