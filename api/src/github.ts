import { command } from "./command";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./wire";
// Base64 plus JSON framing must fit below the 256 MiB controller-frame limit.
const MAX_ARCHIVE = 128 * 1024 * 1024;
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
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  const args = ["api", endpoint, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  return JSON.parse(
    (
      await command("gh", args, {
        input: body === undefined ? undefined : JSON.stringify(body),
        env,
      })
    ).toString(),
  ) as T;
}
export async function githubStatus(env?: NodeJS.ProcessEnv) {
  try {
    const u = await gh<{ login: string }>("user", "GET", undefined, env);
    return { configured: true, login: u.login };
  } catch {
    return { configured: false, login: null };
  }
}
const gitEnv = (env: NodeJS.ProcessEnv, cwd: string, args: string[], timeout = 120_000, onStderr?: (text: string) => void) =>
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
      timeout,
      onStderr,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    },
  );
export const git = (cwd: string, ...args: string[]) => gitEnv(process.env, cwd, args);
const authenticatedGit = (env: NodeJS.ProcessEnv, cwd: string, args: string[], onStderr?: (text: string) => void) => gitEnv(env, cwd,
  ["-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential", ...args], args[0] === "clone" ? 600_000 : 120_000, onStderr);

export function cloneProgress(report: (step: string) => void) {
  let tail = "", last = "", updated = 0;
  return (text: string) => {
    tail = (tail + text).slice(-4096);
    const matches = [...tail.matchAll(/(Receiving objects|Resolving deltas|Updating files):\s*(\d{1,3})%/g)];
    const match = matches.at(-1);
    if (!match || Number(match[2]) > 100) return;
    const label = match[1] === "Receiving objects" ? "Downloading repository" : match[1] === "Resolving deltas" ? "Preparing repository" : "Checking out files";
    const step = `${label} (${Number(match[2])}%)`;
    if (step === last || (Date.now() - updated < 1000 && match[2] !== "100")) return;
    last = step; updated = Date.now(); report(step);
  };
}
export async function checkout(
  data: string,
  id: string,
  repo: string,
  base: string,
  branch: string,
  resume: boolean,
  env: NodeJS.ProcessEnv = process.env,
  progress: (step: string) => void = () => {},
  baseSHA?: string,
) {
  if (!validRepo(repo) || !validBranch(base) || !validBranch(branch))
    throw new Error("Invalid repository or branch");
  if (baseSHA && !/^[a-f0-9]{40}$/.test(baseSHA)) throw new Error("Invalid base revision");
  const cwd = join(data, "checkouts", id);
  await rm(cwd, { recursive: true, force: true });
  await mkdir(join(data, "checkouts"), { recursive: true, mode: 0o700 });
  // Command-scoped helper and HTTPS remote: no credentials are written into the repository.
  progress("Cloning repository");
  try {
    await authenticatedGit({ ...env, LC_ALL: "C" }, data,
      ["clone", "--depth", "1", "--single-branch", "--no-tags", "--progress", "--branch", resume ? branch : base, `https://github.com/${repo}.git`, cwd], cloneProgress(progress));
    if (resume && baseSHA) {
      progress("Loading the run's base revision");
      await authenticatedGit(env, cwd, ["fetch", "--depth", "1", "--no-tags", "origin", baseSHA]);
    }
  } catch {
    throw new ApiError(502, "checkout_failed", "Couldn't download the repository. Check its GitHub access and the server's connection, then retry.");
  }
  await git(cwd, "config", "user.name", "Gond Agent");
  await git(cwd, "config", "user.email", "agent@localhost");
  if (!resume) await git(cwd, "checkout", "-b", branch);
  progress("Packing repository for the workspace");
  let archive: Buffer;
  try {
    archive = await command("tar", ["-czf", "-", "-C", cwd, "."], { maxBuffer: MAX_ARCHIVE });
  } catch (error) {
    if (error instanceof Error && error.message.includes("ERR_CHILD_PROCESS_STDIO_MAXBUFFER"))
      throw new ApiError(413, "repository_too_large", "This repository's checkout is too large for a workspace (128 MiB compressed limit).");
    throw new ApiError(502, "archive_failed", "Couldn't prepare the repository for its workspace. Check the server logs and retry.");
  }
  return { cwd, archive };
}
export async function importBundle(
  cwd: string,
  bundle: Buffer,
  branch: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = join(cwd, ".git", "gond-agent.bundle");
  await writeFile(path, bundle, { mode: 0o600 });
  try {
    await git(cwd, "fetch", "--no-tags", path, "HEAD");
    await git(cwd, "reset", "--hard", "FETCH_HEAD");
    await authenticatedGit(env, cwd, ["push", "origin", `HEAD:refs/heads/${branch}`]);
  } finally {
    await rm(path, { force: true });
  }
}
