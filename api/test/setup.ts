import { beforeEach } from "vitest";

function clearGithubCredentials() {
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_CONFIG_DIR"])
    delete process.env[key];
}

clearGithubCredentials();
beforeEach(clearGithubCredentials);
