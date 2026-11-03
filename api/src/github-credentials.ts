import { statSync } from "node:fs";
import { join } from "node:path";

export function hasServiceGithubCredentials(env: NodeJS.ProcessEnv): boolean {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return true;
  if (!env.GH_CONFIG_DIR) return false;
  try {
    const hosts = statSync(join(env.GH_CONFIG_DIR, "hosts.yml"));
    return hosts.isFile() && hosts.size > 0;
  } catch { return false; }
}
