import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/command";
import { checkout, commitIdentity, gh, GITHUB_INTERACTIVE_TIMEOUT_MS, importBundle, pushBranch } from "../src/github";
import { RetryError } from "../src/retry";

vi.mock("../src/command", async original => {
  const actual = await original<typeof import("../src/command")>();
  return { command: vi.fn((file: string, args: string[], options?: Parameters<typeof actual.command>[2]) =>
    file === "gh" ? Promise.resolve(Buffer.from('{"login":"retry-fixture","id":765}')) : actual.command(file, args, options)) };
});
afterEach(() => vi.restoreAllMocks());
const retry = { sleep: async (_ms: number) => {}, random: () => 0 };

describe("GitHub retry integration", () => {
  it("retries gh network failures but not authorization failures, without returning diagnostics", async () => {
    const mocked = vi.mocked(command);
    mocked.mockImplementationOnce(async (_file, _args, options) => {
      options?.onStderr?.("request to https://secret@private.test failed: connection reset by peer");
      throw new Error("gh failed (1)");
    });
    await expect(gh("user", "GET", undefined, {}, { retry })).resolves.toMatchObject({ login: "retry-fixture" });
    mocked.mockImplementationOnce(async (_file, _args, options) => {
      options?.onStderr?.("gh: bad credentials (HTTP 401), token=secret");
      throw new Error("gh failed (1)");
    });
    const before = mocked.mock.calls.length;
    const error = await gh("user", "GET", undefined, {}, { retry }).catch(error => error);
    expect(error).toMatchObject({ step: "github_api", class: "auth", attempts: 1 });
    expect(mocked.mock.calls.length - before).toBe(1);
    if (!(error instanceof Error)) throw new Error("Expected a safe GitHub error");
    expect(error.message).not.toMatch(/secret|private\.test/);
  });

  it.each<[string, unknown, number]>([
    ["POST", { code: "ECONNREFUSED" }, 0],
    ["POST", new Error("dial tcp: lookup api.github.com: no such host"), 0],
    ["POST", new Error("tls: failed to verify certificate: x509: certificate has expired"), 0],
    ["PATCH", { status: 429, headers: { "Retry-After": "2" } }, 2000],
    ["PUT", { status: 503, headers: { "Retry-After": "3" } }, 3000],
  ])("replays %s only for proven pre-send failures or an explicit server wait (%j)", async (method, failure, wait) => {
    const mocked = vi.mocked(command).mockClear();
    mocked.mockRejectedValueOnce(failure);
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(gh("repos/acme/app/pulls", method, { title: "fixture" }, {}, { retry: { ...retry, sleep } }))
      .resolves.toMatchObject({ login: "retry-fixture" });
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(wait);
  });

  it.each([
    [{ timedOut: true }, "timeout"],
    [new Error("net/http: TLS handshake timeout"), "timeout"],
    [{ code: "ECONNRESET" }, "network"],
    [new Error("TLS read failed: connection reset by peer"), "tls"],
    [new Error("unexpected EOF"), "network"],
    [{ status: 502, headers: { "Retry-After": "1" } }, "server"],
    [{ status: 503 }, "server"],
    [{ status: 503, headers: { "Retry-After": "not a wait" } }, "server"],
    [{ status: 429 }, "rate_limit"],
    [{ status: 403, headers: { "Retry-After": "1" } }, "auth"],
  ])("never replays an ambiguous/permanent POST, even in background publication (%j)", async (failure, kind) => {
    const mocked = vi.mocked(command).mockClear();
    mocked.mockRejectedValueOnce(failure);
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(gh("repos/acme/app/pulls", "POST", {}, {}, { backgroundPublication: true, retry: { ...retry, sleep } }))
      .rejects.toMatchObject({ step: "github_api", class: kind, attempts: 1, retryable: false });
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([{ timedOut: true }, { status: 502 }, { status: 503 }, { status: 429 }])("keeps GET replay classification unchanged (%j)", async failure => {
    const mocked = vi.mocked(command).mockClear();
    mocked.mockRejectedValueOnce(failure);
    await expect(gh("user", "GET", undefined, {}, { retry })).resolves.toMatchObject({ login: "retry-fixture" });
    expect(mocked).toHaveBeenCalledTimes(2);
  });

  it("shares one interactive budget across command attempts and backoff", async () => {
    let elapsed = 0;
    const mocked = vi.mocked(command).mockClear();
    mocked.mockImplementationOnce(async () => {
      elapsed += 45_000;
      throw { code: "ECONNRESET" };
    }).mockImplementationOnce(async (_file, _args, options) => {
      elapsed += options!.timeout!;
      throw { timedOut: true };
    });
    const sleep = vi.fn(async (ms: number) => { elapsed += ms; });
    await expect(gh("user", "GET", undefined, {}, { retry: { sleep, now: () => elapsed, random: () => 1 } }))
      .rejects.toMatchObject({ step: "github_api", class: "timeout", attempts: 2 });
    expect(mocked.mock.calls.map(([, , options]) => options?.timeout)).toEqual([GITHUB_INTERACTIVE_TIMEOUT_MS, 14_000]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000]);
    expect(elapsed).toBe(GITHUB_INTERACTIVE_TIMEOUT_MS);
  });

  it("does not wait past the interactive deadline or shorten Retry-After", async () => {
    const mocked = vi.mocked(command).mockClear();
    mocked.mockRejectedValueOnce({ status: 429, headers: { "Retry-After": "61" } });
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(gh("user", "GET", undefined, {}, { retry: { sleep, now: () => 0, random: () => 0, totalTimeoutMs: GITHUB_INTERACTIVE_TIMEOUT_MS * 10 } }))
      .rejects.toMatchObject({ class: "rate_limit", attempts: 1 });
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves shorter command limits and requires explicit publication opt-in for the full schedule", async () => {
    const mocked = vi.mocked(command).mockClear();
    await gh("user", "GET", undefined, {}, { timeout: 5000, retry: { now: () => 0 } });
    expect(mocked.mock.calls[0][2]?.timeout).toBe(5000);
    mocked.mockClear();
    for (let attempt = 0; attempt < 4; attempt++) {
      mocked.mockRejectedValueOnce({ status: 503, headers: { "Retry-After": "65" } });
    }
    let elapsed = 0;
    const sleep = vi.fn(async (ms: number) => { elapsed += ms; });
    await expect(commitIdentity({ GH_TOKEN: "background-identity-fixture" }, {
      backgroundPublication: true, retry: { sleep, now: () => elapsed, random: () => 0 },
    })).resolves.toEqual({ name: "retry-fixture", email: "765+retry-fixture@users.noreply.github.com" });
    expect(mocked).toHaveBeenCalledTimes(5);
    expect(mocked.mock.calls.map(([, , options]) => options?.timeout)).toEqual(Array(5).fill(120_000));
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(Array(4).fill(65_000));
  });

  it("does not share an in-flight publication identity lookup with an interactive lookup", async () => {
    const mocked = vi.mocked(command).mockClear();
    let complete!: (value: Buffer) => void;
    mocked.mockImplementationOnce(() => new Promise<Buffer>(resolve => { complete = resolve; }));
    const env = { GH_TOKEN: "concurrent-identity-fixture" }, timing = { now: () => 0 };
    const background = commitIdentity(env, { backgroundPublication: true, retry: timing });
    const interactive = commitIdentity(env, { retry: timing });
    complete(Buffer.from('{"login":"retry-fixture","id":765}'));
    await Promise.all([background, interactive]);
    expect(mocked.mock.calls.map(([, , options]) => options?.timeout)).toEqual([120_000, GITHUB_INTERACTIVE_TIMEOUT_MS]);
  });

  it("cleans partial clones, retries fetch, and can push an imported retained commit after exhaustion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gond-agent-retry-git-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const remote = join(dir, "remote"), worker = join(dir, "worker"), bin = join(dir, "bin"), state = join(dir, "state");
      await mkdir(remote); await mkdir(worker); await mkdir(bin);
      await writeFile(state, JSON.stringify({ clone: 1, fetch: 1, push: 2, calls: [] }));
      // Only network Git invocations use this per-command PATH shim. Successful calls use real Git.
      await writeFile(join(bin, "git"), `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),path=${JSON.stringify(state)},state=JSON.parse(fs.readFileSync(path,'utf8'));
const action=['clone','fetch','push'].find(action=>args.includes(action));
if(action){
  state.calls.push(action);
  if(state[action]>0){
    state[action]--; fs.writeFileSync(path,JSON.stringify(state));
    if(action==='clone'){const dest=args.at(-1);fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(dest+'/partial','dirty');}
    process.stderr.write(action==='push'?'fatal: unable to access https://secret@private.test: The requested URL returned error: 500':'fatal: unable to access https://secret@private.test: connection reset by peer');process.exit(1);
  }
  if(action==='clone' && fs.existsSync(args.at(-1)+'/partial')){process.stderr.write('partial clone was not cleaned');process.exit(1);}
  fs.writeFileSync(path,JSON.stringify(state));
}
const result=cp.spawnSync('/usr/bin/git',args,{stdio:'inherit',env:process.env});process.exit(result.status??1);
`, { mode: 0o700 });
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "retry-fixture-token", GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/acme/app.git" };
      const git = async (cwd: string, ...args: string[]) => (await command("/usr/bin/git", args, { cwd, env })).toString().trim();
      await git(remote, "init", "-b", "main");
      await writeFile(join(remote, "base.txt"), "base\n");
      await git(remote, "add", ".");
      await git(remote, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "base");
      const checked = await checkout(dir, "run_retry", "acme/app", "main", "gond-agent/retry", false, env, () => {}, undefined, retry);
      await command("tar", ["-xzf", "-", "-C", worker], { input: checked.archive });
      await writeFile(join(worker, "kept.txt"), "retained work\n");
      await git(worker, "add", ".");
      await git(worker, "commit", "-m", "kept work");
      let head = await git(worker, "rev-parse", "HEAD");
      const base = await git(remote, "rev-parse", "main");
      const bundle = join(dir, "worker.bundle");
      await git(worker, "bundle", "create", bundle, "HEAD");
      await importBundle(checked.cwd, await readFile(bundle), "gond-agent/retry", env, retry);
      expect(await git(remote, "rev-parse", "gond-agent/retry")).toBe(head);
      const published = JSON.parse(await readFile(state, "utf8"));
      expect(published.calls.filter((call: string) => call === "push")).toHaveLength(3);
      published.push = 5;
      await writeFile(state, JSON.stringify(published));
      await writeFile(join(worker, "kept.txt"), "retained work after another turn\n");
      await git(worker, "add", ".");
      await git(worker, "commit", "-m", "more kept work");
      head = await git(worker, "rev-parse", "HEAD");
      await git(worker, "bundle", "create", bundle, "HEAD");
      const error = await importBundle(checked.cwd, await readFile(bundle), "gond-agent/retry", env, retry).catch(error => error);
      expect(error).toBeInstanceOf(RetryError);
      expect(error).toMatchObject({ step: "push", class: "server", attempts: 5 });
      expect(JSON.stringify(error)).not.toMatch(/secret|private\.test/);
      expect(await git(checked.cwd, "rev-parse", "HEAD")).toBe(head);
      await expect(readFile(join(checked.cwd, ".git/gond-agent.bundle"))).rejects.toMatchObject({ code: "ENOENT" });
      await pushBranch(checked.cwd, "gond-agent/retry", env, retry);
      expect(await git(remote, "rev-parse", "gond-agent/retry")).toBe(head);
      // Resume exercises the separately retried pinned-base fetch, not a full re-clone.
      const resumed = await checkout(dir, "run_resume", "acme/app", "main", "gond-agent/retry", true, env, () => {}, base, retry);
      expect(await git(resumed.cwd, "show", "HEAD:kept.txt")).toBe("retained work after another turn");
      const calls = JSON.parse(await readFile(state, "utf8")).calls as string[];
      expect(calls.filter(call => call === "clone")).toHaveLength(3);
      expect(calls.filter(call => call === "fetch")).toHaveLength(2);
      expect(calls.filter(call => call === "push")).toHaveLength(9);
      // A genuine non-fast-forward is permanent, unlike the transport failures above.
      await git(remote, "checkout", "gond-agent/retry");
      await writeFile(join(remote, "upstream.txt"), "someone else's work\n");
      await git(remote, "add", ".");
      await git(remote, "-c", "user.name=Upstream", "-c", "user.email=upstream@example.test", "commit", "-m", "upstream change");
      await git(remote, "checkout", "main");
      await expect(pushBranch(checked.cwd, "gond-agent/retry", env, retry)).rejects.toMatchObject({ step: "push", class: "rejected", attempts: 1, retryable: false });
      const afterRejection = JSON.parse(await readFile(state, "utf8")).calls as string[];
      expect(afterRejection.filter(call => call === "push")).toHaveLength(10);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
