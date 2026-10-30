import { command } from "./command";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const validRepo = (repo: string) =>
  /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) &&
  !repo.endsWith("/.") &&
  !repo.endsWith("/..");
export const validBranch = (b: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(b) &&
  !b.includes("..") &&
  !b.includes("@{") &&
  !b.endsWith("/") &&
  !b.endsWith(".lock");
export async function gh<T>(
  endpoint: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const args = ["api", endpoint, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  return JSON.parse(
    (
      await command("gh", args, {
        input: body === undefined ? undefined : JSON.stringify(body),
      })
    ).toString(),
  ) as T;
}
export async function githubStatus() {
  try {
    const u = await gh<{ login: string }>("user");
    return { configured: true, login: u.login };
  } catch {
    return { configured: false, login: null };
  }
}
export const git = (cwd: string, ...args: string[]) =>
  command(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=always",
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
export async function checkout(
  data: string,
  id: string,
  repo: string,
  base: string,
  branch: string,
  resume: boolean,
) {
  if (!validRepo(repo) || !validBranch(base) || !validBranch(branch))
    throw new Error("Invalid repository or branch");
  const cwd = join(data, "checkouts", id);
  await rm(cwd, { recursive: true, force: true });
  await mkdir(join(data, "checkouts"), { recursive: true, mode: 0o700 });
  // gh obtains credentials from the mounted host configuration. No token enters an archive or worker.
  await command(
    "gh",
    ["repo", "clone", repo, cwd, "--", "--branch", resume ? branch : base],
    { timeout: 600_000 },
  );
  await git(cwd, "config", "user.name", "Gond Agent");
  await git(cwd, "config", "user.email", "agent@localhost");
  if (!resume) await git(cwd, "checkout", "-b", branch);
  const archive = await command("tar", ["-czf", "-", "-C", cwd, "."]);
  return { cwd, archive };
}
export async function importBundle(
  cwd: string,
  bundle: Buffer,
  branch: string,
) {
  const path = join(cwd, ".git", "gond-agent.bundle");
  await writeFile(path, bundle, { mode: 0o600 });
  try {
    await git(cwd, "fetch", "--no-tags", path, "HEAD");
    await git(cwd, "reset", "--hard", "FETCH_HEAD");
    // The branch was validated on creation; git uses the host gh credential helper.
    await command("gh", ["auth", "setup-git"]);
    await git(cwd, "push", "origin", `HEAD:refs/heads/${branch}`);
  } finally {
    await rm(path, { force: true });
  }
}
