import { createHash } from "node:crypto";
import { command } from "./command";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./wire";
import { ClassifiedRetryFailure, classifyRetryFailure, RetryError, withRetry, type RetryOptions } from "./retry";

// Keep bounded classification for alternate command adapters; command() itself
// classifies raw diagnostics before discarding them.
async function githubCommand(file: string, args: string[], options: NonNullable<Parameters<typeof command>[2]> = {}) {
  let stderr = "";
  const started = Date.now();
  try {
    return await command(file, args, { ...options, onStderr: text => {
      stderr = (stderr + text).slice(-64 * 1024);
      options.onStderr?.(text);
    } });
  } catch (error) {
    if (error instanceof ClassifiedRetryFailure) throw error;
    const fields = error && typeof error === "object" ? error : {};
    const message = error instanceof Error ? error.message : "message" in fields ? fields.message : "";
    throw new ClassifiedRetryFailure(classifyRetryFailure({
      ...fields, message, stderr: stderr || ("stderr" in fields ? fields.stderr : ""),
      timedOut: ("timedOut" in fields && fields.timedOut === true) || Date.now() - started >= (options.timeout ?? 120_000),
    }));
  }
}
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
export const GITHUB_INTERACTIVE_TIMEOUT_MS = 60_000;
export interface GitHubOptions {
  timeout?: number;
  maxBuffer?: number;
  retry?: RetryOptions;
  /** Only unattended publication should opt out of the interactive total deadline. */
  backgroundPublication?: boolean;
}

export async function gh<T>(
  endpoint: string,
  method = "GET",
  body?: unknown,
  env?: NodeJS.ProcessEnv,
  options: GitHubOptions = {},
): Promise<T> {
  const args = ["api", endpoint, "--method", method, "--include"];
  if (body !== undefined) args.push("--input", "-");
  return withRetry("github_api", async (_attempt, remainingMs) => {
    let output = (
      await githubCommand("gh", args, {
        timeout: Math.min(options.timeout ?? 120_000, remainingMs),
        maxBuffer: options.maxBuffer,
        input: body === undefined ? undefined : JSON.stringify(body),
        env,
      }).catch(error => {
        identities.clear();
        const failure = classifyRetryFailure(error);
        // A lost response to a mutation is ambiguous: only replay proven pre-send
        // failures or an explicit 429/503 server wait, never ambiguous timeouts/resets.
        throw new ClassifiedRetryFailure({
          ...failure,
          retryable: failure.retryable && (method.toUpperCase() === "GET" || failure.safeToReplay === true),
        });
      })
    ).toString();
    // gh has no pagination here. Strip response blocks (including interim headers),
    // accepting both CRLF and LF without touching JSON body content.
    while (/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(output)) {
      const boundary = /\r?\n\r?\n/.exec(output);
      if (!boundary) break;
      output = output.slice(boundary.index + boundary[0].length);
    }
    return JSON.parse(output) as T;
  }, {
    ...options.retry,
    totalTimeoutMs: options.backgroundPublication ? options.retry?.totalTimeoutMs
      : Math.min(options.retry?.totalTimeoutMs ?? GITHUB_INTERACTIVE_TIMEOUT_MS, GITHUB_INTERACTIVE_TIMEOUT_MS),
  });
}
export async function githubStatus(env?: NodeJS.ProcessEnv) {
  try {
    const u = await gh<{ login: string }>("user", "GET", undefined, env);
    return { configured: true, login: u.login };
  } catch {
    return { configured: false, login: null };
  }
}
export interface CommitIdentity { name: string; email: string }
const identities = new Map<string, {expires: number; value: Promise<CommitIdentity>}>();
export function commitIdentity(env: NodeJS.ProcessEnv = process.env, options: GitHubOptions = {}): Promise<CommitIdentity> {
  // Do not let an interactive lookup inherit an in-flight publication's longer budget.
  const key = createHash("sha256").update(JSON.stringify([env.GH_TOKEN ?? env.GITHUB_TOKEN, env.GH_CONFIG_DIR, env.HOME, !!options.backgroundPublication])).digest("hex");
  for (const [cachedKey, cached] of identities) if (cached.expires <= Date.now()) identities.delete(cachedKey);
  let identity = identities.get(key)?.value;
  if (!identity) {
    identity = gh<{ login: string; id: number }>("user", "GET", undefined, env, options).then(user => {
      if (!user.login || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error("Missing GitHub identity");
      return { name: user.login, email: `${user.id}+${user.login}@users.noreply.github.com` };
    }).catch(error => {
      identities.delete(key);
      const failure = new ApiError(409, "github_identity", "Connect a GitHub account before publishing changes.");
      if (error instanceof RetryError) failure.cause = error;
      throw failure;
    });
    identities.set(key, {expires:Date.now() + 3600_000, value:identity});
  }
  return identity.then(value => {
    const result = { name: env.GOND_AGENT_COMMIT_NAME || value.name, email: env.GOND_AGENT_COMMIT_EMAIL || value.email };
    if (Object.values(result).some(v => !v.trim() || /[\r\n\0<>]/.test(v))) throw new ApiError(400, "commit_identity", "Check the configured commit name and email.");
    return result;
  });
}
const gitEnv = (env: NodeJS.ProcessEnv, cwd: string, args: string[], timeout = 120_000, onStderr?: (text: string) => void) =>
  githubCommand(
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
  retryOptions?: RetryOptions,
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
    await withRetry("clone", async () => {
      // A failed clone may leave .git and partial objects; each attempt starts clean.
      await rm(cwd, { recursive: true, force: true });
      await authenticatedGit({ ...env, LC_ALL: "C" }, data,
        ["clone", "--depth", "1", "--single-branch", "--no-tags", "--progress", "--branch", resume ? branch : base, `https://github.com/${repo}.git`, cwd], cloneProgress(progress));
    }, retryOptions);
    if (resume && baseSHA) {
      progress("Loading the run's base revision");
      await withRetry("fetch", () => authenticatedGit(env, cwd, ["fetch", "--depth", "1", "--no-tags", "origin", baseSHA]), retryOptions);
    }
  } catch (error) {
    // Cleanup must not replace the safe operation failure with a filesystem path/error.
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
    // Preserve the existing checkout API contract and expose safe retry metadata to callers.
    const failure = new ApiError(502, "checkout_failed", "Couldn't download the repository. Check its GitHub access and the server's connection, then retry.");
    failure.cause = error;
    throw failure;
  }
  const identity = await commitIdentity(env);
  await git(cwd, "config", "user.name", identity.name);
  await git(cwd, "config", "user.email", identity.email);
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
export interface PushOptions {
  /** Set for an explicit new branch until publication is confirmed; never infer it from a name. */
  lease?: "create-only";
  /** Policy guard for every push attempt, outside retry classification. */
  beforeAttempt?: (context: { cwd: string; branch: string; head: string }) => Promise<void>;
}

export async function importBundle(
  cwd: string,
  bundle: Buffer,
  branch: string,
  env: NodeJS.ProcessEnv = process.env,
  retryOptions?: RetryOptions,
  pushOptions: PushOptions = {},
) {
  if (!validBranch(branch)) throw new Error("Invalid branch");
  const path = join(cwd, ".git", "gond-agent.bundle");
  try {
    // Import is local and must not replay arbitrary bundle failures. Name it for service errors.
    await withRetry("import", async () => {
      await writeFile(path, bundle, { mode: 0o600 });
      await git(cwd, "fetch", "--no-tags", path, "HEAD");
      await git(cwd, "reset", "--hard", "FETCH_HEAD");
    }, { maxAttempts: 1 });
    await pushBranch(cwd, branch, env, retryOptions, pushOptions);
  } finally {
    await withRetry("import", () => rm(path, { force: true }), { maxAttempts: 1 });
  }
}

/** Retry publication of an already imported commit without needing the worker bundle again. */
export async function pushBranch(cwd: string, branch: string, env: NodeJS.ProcessEnv = process.env, retryOptions?: RetryOptions, options: PushOptions = {}) {
  if (!validBranch(branch)) throw new Error("Invalid branch");
  const { lease, beforeAttempt } = options;
  // Pin guarded/create-only publication so reconciliation compares the exact commit sent.
  const head = lease || beforeAttempt ? (await git(cwd, "rev-parse", "HEAD")).toString().trim() : "HEAD";
  if (head !== "HEAD" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Invalid publication commit");
  const ref = `refs/heads/${branch}`;
  await withRetry("push", async () => {
    try {
      await authenticatedGit(env, cwd, ["push", ...(lease === "create-only" ? [`--force-with-lease=${ref}:`] : []), "origin", `${head}:${ref}`]);
    } catch (error) {
      if (lease === "create-only" && classifyRetryFailure(error).staleLease) {
        // The first create may have succeeded before its response was lost. Never
        // weaken the lease: reconcile with one owner-credential-scoped read instead.
        try {
          const remote = (await authenticatedGit(env, cwd, ["ls-remote", "--refs", "origin", ref])).toString().trim();
          if (remote === `${head}\t${ref}`) return;
        } catch { /* Unverifiable state remains the original non-retryable rejection. */ }
      }
      throw error;
    }
  }, {
    ...retryOptions,
    beforeAttempt: beforeAttempt ? async () => {
      if (retryOptions?.beforeAttempt) await retryOptions.beforeAttempt();
      await beforeAttempt({ cwd, branch, head });
    } : retryOptions?.beforeAttempt,
  });
}
