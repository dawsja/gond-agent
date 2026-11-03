import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("starts tests without ambient GitHub service credentials", () => {
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR"])
    expect(process.env[key], key).toBeUndefined();
});

it("does not configure implicit service GitHub credentials in packaged new installs", () => {
  expect(readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8")).not.toMatch(/GH_CONFIG_DIR=/);
  expect(readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8")).not.toMatch(/GH_CONFIG_DIR:/);
});
