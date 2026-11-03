import { command } from "./command";
import type { Config } from "./config";
import { getSetting, type Store } from "./db";

type Docker = (args: string[]) => Promise<Buffer | string>;

/**
 * Removes Claude Code and Codex runtime volumes recorded by the upgrade migration. Only volumes that
 * Docker reports with this instance's runtime labels are removed; the record is kept until it works.
 */
export async function removeRetiredRuntimes(db: Store, cfg: Pick<Config, "dockerBin">, docker: Docker = args => command(cfg.dockerBin, args, { timeout: 60_000 })) {
  const pending = getSetting<{ instance?: string; volumes: string[] }>(db, "retired-runtime-cleanup");
  if (!pending) return [];
  const removed: string[] = [];
  if (pending.instance && /^[a-f0-9]{24}$/.test(pending.instance)) {
    const labelled = (await docker(["volume", "ls", "--quiet", "--filter", "label=io.gond-agent.runtime=true", "--filter", `label=io.gond-agent.runtime-instance=${pending.instance}`]))
      .toString().trim().split(/\s+/).filter(name => /^gond-agent-cli-[a-f0-9]{32}$/.test(name));
    for (const volume of labelled) {
      // An interrupted installation left a container named after its staging volume.
      if (pending.volumes.includes(volume)) await docker(["rm", "--force", `${volume}-install`]).catch(() => {});
      await docker(["volume", "rm", volume]);
      removed.push(volume);
    }
  }
  db.prepare("DELETE FROM settings WHERE key='retired-runtime-cleanup'").run();
  console.log(removed.length ? `Removed retired coding-agent runtime volumes: ${removed.join(", ")}.` : "No retired coding-agent runtime volumes remained.");
  return removed;
}
