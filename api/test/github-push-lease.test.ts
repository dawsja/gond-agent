import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { command } from "../src/command";
import { importBundle, pushBranch, type PushOptions } from "../src/github";
import { ApiError } from "../src/wire";
import { publicationPushOptions } from "../src/runs/publication";

const retry = { sleep: async () => {}, random: () => 0 };
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(initial: { rejectLease?: boolean; loseResponse?: boolean; failBeforePush?: number; failBeforePushMessage?: string; failRemoteRead?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gond-agent-push-lease-"));
  directories.push(dir);
  const remote = join(dir, "remote"), cwd = join(dir, "api"), bin = join(dir, "bin"), state = join(dir, "state.json");
  await Promise.all([remote, cwd, bin].map(path => mkdir(path)));
  await writeFile(state, JSON.stringify({ ...initial, events: [] }));
  // Inject transport/lease outcomes only. Objects, refs, imports and successful pushes use real Git.
  await writeFile(join(bin, "git"), `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const args=process.argv.slice(2),path=${JSON.stringify(state)},state=JSON.parse(fs.readFileSync(path,'utf8'));
const action=['push','ls-remote'].find(action=>args.includes(action));
const save=()=>fs.writeFileSync(path,JSON.stringify(state));
if(action){state.events.push({kind:action,args});save();}
if(action==='ls-remote' && state.failRemoteRead){process.stderr.write('connection refused');process.exit(1);}
if(action==='push'){
  if(state.failBeforePush>0){state.failBeforePush--;save();process.stderr.write(state.failBeforePushMessage || 'HTTP 500');process.exit(1);}
  if(state.rejectLease && args.some(arg=>arg.startsWith('--force-with-lease='))){process.stderr.write('! [rejected] HEAD -> fixture (stale info)');process.exit(1);}
}
const result=cp.spawnSync('/usr/bin/git',args,{stdio:'inherit',env:process.env});
if(action==='push' && result.status===0 && state.loseResponse){
  state.loseResponse=false;state.rejectLease=true;save();process.stderr.write('connection reset by peer');process.exit(1);
}
process.exit(result.status??1);
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "owner-only-fixture-token" };
  const git = async (folder: string, ...args: string[]) => (await command("/usr/bin/git", args, { cwd: folder, env })).toString().trim();
  await git(remote, "init", "--bare", "-b", "main");
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.name", "Fixture");
  await git(cwd, "config", "user.email", "fixture@example.test");
  await writeFile(join(cwd, "work.txt"), "base\n");
  await git(cwd, "add", "."); await git(cwd, "commit", "-m", "base");
  const base = await git(cwd, "rev-parse", "HEAD");
  await git(cwd, "remote", "add", "origin", remote);
  await git(cwd, "push", "origin", "main");
  const branch = "feat/explicit-fixture", ref = `refs/heads/${branch}`;
  await git(cwd, "checkout", "-b", branch);
  await writeFile(join(cwd, "work.txt"), "new work\n");
  await git(cwd, "commit", "-am", "new work");
  const head = await git(cwd, "rev-parse", "HEAD");
  const events = async () => JSON.parse(await readFile(state, "utf8")).events as { kind: string; args?: string[]; head?: string }[];
  const beforePush: PushOptions["beforePush"] = async context => {
    expect(context).toEqual({ cwd, branch, head: await git(cwd, "rev-parse", "HEAD") });
    const current = JSON.parse(await readFile(state, "utf8"));
    current.events.push({ kind: "guard", head: context.head });
    await writeFile(state, JSON.stringify(current));
  };
  return { cwd, remote, env, git, branch, ref, head, base, events, beforePush };
}

describe("create-only publication leases", () => {
  it("accepts a rejected create-only lease only when the real remote ref already equals the pushed commit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture({ rejectLease: true });
    await f.git(f.cwd, "push", "origin", `${f.head}:${f.ref}`);
    await pushBranch(f.cwd, f.branch, f.env, retry, { lease: "create-only", beforePush: f.beforePush });
    expect(await f.git(f.remote, "rev-parse", f.ref)).toBe(f.head);
    const events = await f.events();
    expect(events.map(event => event.kind)).toEqual(["guard", "push", "ls-remote"]);
    expect(events[1].args).toContain(`--force-with-lease=${f.ref}:`);
    expect(events[2].args?.slice(-4)).toEqual(["ls-remote", "--refs", "origin", f.ref]);
  });

  it.each(["different", "missing", "unavailable"])("keeps a %s remote ref rejected without weakening the lease or retrying the write", async state => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture({ rejectLease: state !== "different", failRemoteRead: state === "unavailable" });
    // The different-head case is a real Git lease rejection even though a plain push could fast-forward it.
    if (state !== "missing") await f.git(f.remote, "update-ref", f.ref, f.base);
    await expect(pushBranch(f.cwd, f.branch, f.env, retry, { lease: "create-only", beforePush: f.beforePush }))
      .rejects.toMatchObject({ step: "push", class: "rejected", attempts: 1, retryable: false });
    expect(await f.git(f.remote, "for-each-ref", "--format=%(objectname)", f.ref)).toBe(state === "missing" ? "" : f.base);
    expect((await f.events()).map(event => event.kind)).toEqual(["guard", "push", "ls-remote"]);
  });

  it("keeps the lease and rechecks the guard after a lost successful response, then uses normal pushes for later commits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture({ loseResponse: true });
    const bundle = join(f.cwd, ".git", "fixture.bundle");
    await f.git(f.cwd, "bundle", "create", bundle, "HEAD");
    await importBundle(f.cwd, await readFile(bundle), f.branch, f.env, retry, { lease: "create-only", beforePush: f.beforePush });
    expect(await f.git(f.remote, "rev-parse", f.ref)).toBe(f.head);
    const events = await f.events();
    expect(events.map(event => event.kind)).toEqual(["guard", "push", "guard", "push", "ls-remote"]);
    for (const event of events.filter(event => event.kind === "push")) {
      expect(event.args).toContain(`--force-with-lease=${f.ref}:`);
      expect(event.args?.at(-1)).toBe(`${f.head}:${f.ref}`);
    }
    await expect(readFile(join(f.cwd, ".git", "gond-agent.bundle"))).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(join(f.cwd, "work.txt"), "follow-up work\n");
    await f.git(f.cwd, "commit", "-am", "follow-up");
    const next = await f.git(f.cwd, "rev-parse", "HEAD");
    await pushBranch(f.cwd, f.branch, f.env, retry, { beforePush: f.beforePush });
    expect(await f.git(f.remote, "rev-parse", f.ref)).toBe(next);
    const later = (await f.events()).slice(events.length);
    expect(later.map(event => event.kind)).toEqual(["guard", "push"]);
    expect(later[1].args?.some(arg => arg.startsWith("--force"))).toBe(false);
  });

  it("keeps helper-selected leases and guards through a network failure and lost-response reconciliation, then publishes normally", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture({ failBeforePush: 1, failBeforePushMessage: "connection reset by peer", loseResponse: true });
    const run = { explicit_branch: true, pushed: false };
    const options = publicationPushOptions(run, f.beforePush);
    expect(options).toEqual({ lease: "create-only", beforePush: f.beforePush });
    const beforeAttempt = vi.fn(async () => {});
    let waits = 0;
    const sleep = vi.fn(async () => {
      // The first attempt never reached Git; the second wrote the exact commit but lost its response.
      expect(await f.git(f.remote, "for-each-ref", "--format=%(objectname)", f.ref))
        .toBe(++waits === 1 ? "" : f.head);
    });
    const bundle = join(f.cwd, ".git", "helper.bundle");
    await f.git(f.cwd, "bundle", "create", bundle, "HEAD");
    await importBundle(f.cwd, await readFile(bundle), f.branch, f.env, { ...retry, sleep, beforeAttempt }, options);
    expect(await f.git(f.remote, "rev-parse", f.ref)).toBe(f.head);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(beforeAttempt).toHaveBeenCalledTimes(3);
    const events = await f.events();
    expect(events.map(event => event.kind)).toEqual(["guard", "push", "guard", "push", "guard", "push", "ls-remote"]);
    expect(events.filter(event => event.kind === "guard").map(event => event.head)).toEqual([f.head, f.head, f.head]);
    for (const event of events.filter(event => event.kind === "push")) {
      expect(event.args).toContain(`--force-with-lease=${f.ref}:`);
      expect(event.args?.at(-1)).toBe(`${f.head}:${f.ref}`);
    }
    expect(events.at(-1)?.args?.slice(-4)).toEqual(["ls-remote", "--refs", "origin", f.ref]);
    await expect(readFile(join(f.cwd, ".git", "gond-agent.bundle"))).rejects.toMatchObject({ code: "ENOENT" });

    run.pushed = true;
    await writeFile(join(f.cwd, "work.txt"), "published follow-up\n");
    await f.git(f.cwd, "commit", "-am", "published follow-up");
    const next = await f.git(f.cwd, "rev-parse", "HEAD");
    const laterOptions = publicationPushOptions(run, f.beforePush);
    expect(laterOptions).toEqual({ lease: undefined, beforePush: f.beforePush });
    await pushBranch(f.cwd, f.branch, f.env, { ...retry, beforeAttempt }, laterOptions);
    expect(await f.git(f.remote, "rev-parse", f.ref)).toBe(next);
    expect(beforeAttempt).toHaveBeenCalledTimes(4);
    const later = (await f.events()).slice(events.length);
    expect(later.map(event => event.kind)).toEqual(["guard", "push"]);
    expect(later[0].head).toBe(next);
    expect(later[1].args?.at(-1)).toBe(`${next}:${f.ref}`);
    expect(later[1].args?.some(arg => arg.startsWith("--force"))).toBe(false);
  });

  it("never fast-forwards a branch created by someone else between a network failure and the retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture({ failBeforePush: 1, failBeforePushMessage: "connection reset by peer" });
    const sleep = vi.fn(async () => {
      expect((await f.events()).map(event => event.kind)).toEqual(["guard", "push"]);
      expect(await f.git(f.remote, "for-each-ref", "--format=%(refname)", f.ref)).toBe("");
      // Another publisher creates an ancestor ref: a normal push would silently fast-forward it.
      await f.git(f.remote, "update-ref", f.ref, f.base);
      await f.git(f.cwd, "merge-base", "--is-ancestor", f.base, f.head);
    });
    await expect(pushBranch(f.cwd, f.branch, f.env, { ...retry, sleep },
      publicationPushOptions({ explicit_branch: true, pushed: false }, f.beforePush)))
      .rejects.toMatchObject({ step: "push", class: "rejected", attempts: 2, retryable: false });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(await f.git(f.remote, "rev-parse", f.ref)).toBe(f.base);
    const events = await f.events();
    expect(events.map(event => event.kind)).toEqual(["guard", "push", "guard", "push", "ls-remote"]);
    expect(events.filter(event => event.kind === "guard").map(event => event.head)).toEqual([f.head, f.head]);
    for (const event of events.filter(event => event.kind === "push")) {
      expect(event.args).toContain(`--force-with-lease=${f.ref}:`);
      expect(event.args?.at(-1)).toBe(`${f.head}:${f.ref}`);
    }
  });

  it("lets a guard refuse a retry before any further push, preserving its original policy error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await fixture({ failBeforePush: 1 });
    const blocked = new ApiError(409, "publication_refused", "Publication requires approval.");
    let guards = 0;
    const beforePush: PushOptions["beforePush"] = async context => {
      await f.beforePush!(context);
      if (++guards === 2) throw blocked;
    };
    await expect(pushBranch(f.cwd, f.branch, f.env, retry, { lease: "create-only", beforePush })).rejects.toBe(blocked);
    expect((await f.events()).map(event => event.kind)).toEqual(["guard", "push", "guard"]);
    expect(await f.git(f.remote, "for-each-ref", "--format=%(refname)", f.ref)).toBe("");
  });
});
