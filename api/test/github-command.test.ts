import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import { gh } from "../src/github";

it.each([
  ["refused", "", "dial tcp 127.0.0.1:443: connect: connection refused", true, 0],
  ["timeout", "", "net/http: TLS handshake timeout", false, 0],
  ["unavailable", "HTTP/2.0 503 Service Unavailable\r\nRetry-After: 2\r\n\r\n{}", "", true, 2000],
  ["ambiguous", "HTTP/2.0 503 Service Unavailable\r\n\r\n{}", "", false, 0],
])("preserves mutation replay safety across real command classification: %s", async (_name, stdout, stderr, replay, wait) => {
  const dir = await mkdtemp(join(tmpdir(), "gond-agent-gh-mutation-"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const bin = join(dir, "bin"), state = join(dir, "attempts");
    await mkdir(bin);
    await writeFile(join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs'), state = ${JSON.stringify(state)};
const attempt = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) + 1 : 1;
fs.writeFileSync(state, String(attempt));
if (attempt === 1) {
  process.stdout.write(${JSON.stringify(stdout)});
  process.stderr.write(${JSON.stringify(stderr)});
  process.exitCode = 1;
} else process.stdout.write('{"number":42}');
`, { mode: 0o700 });
    const sleep = vi.fn(async (_ms: number) => {});
    const result = gh("repos/acme/app/pulls", "POST", { title: "fixture" },
      { ...process.env, PATH: `${bin}:${process.env.PATH}` }, { retry: { sleep, random: () => 0 } });
    if (replay) {
      await expect(result).resolves.toEqual({ number: 42 });
      expect(await readFile(state, "utf8")).toBe("2");
      expect(sleep).toHaveBeenCalledExactlyOnceWith(wait);
    } else {
      await expect(result).rejects.toMatchObject({ attempts: 1, retryable: false });
      expect(await readFile(state, "utf8")).toBe("1");
      expect(sleep).not.toHaveBeenCalled();
    }
  } finally {
    log.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it("retries real gh command failures using included stdout headers, then parses JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gond-agent-gh-command-"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const bin = join(dir, "bin"), state = join(dir, "attempts");
    await mkdir(bin);
    await writeFile(join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
if (!process.argv.includes('--include')) process.exit(2);
const state = ${JSON.stringify(state)};
const attempt = fs.existsSync(state) ? Number(fs.readFileSync(state, 'utf8')) + 1 : 1;
fs.writeFileSync(state, String(attempt));
if (attempt <= 2) {
  process.stdout.write('HTTP/2.0 500 Internal Server Error\\r\\nContent-Type: application/json\\r\\n\\r\\n{"secret":"private-token"}');
  process.stderr.write('request https://private-token@private.example.test failed');
  process.exitCode = 1;
} else if (attempt === 3) {
  process.stdout.write('HTTP/2.0 429 Too Many Requests\\nRetry-After: 3\\n\\n{"secret":"private-token"}');
  process.exitCode = 1;
} else {
  process.stdout.write('HTTP/1.1 100 Continue\\r\\n\\r\\nHTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n{"login":"fixture","text":"HTTP/2.0 is body text"}');
}
`, { mode: 0o700 });
    const sleep = vi.fn(async (_ms: number) => {});
    const result = await gh<{ login: string; text: string }>("user", "GET", undefined,
      { ...process.env, PATH: `${bin}:${process.env.PATH}` }, { retry: { sleep, random: () => 0 } });
    expect(result).toEqual({ login: "fixture", text: "HTTP/2.0 is body text" });
    expect(await readFile(state, "utf8")).toBe("4");
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([0, 0, 3000]);
    expect(log.mock.calls.map(([, fields]) => fields.class)).toEqual(["server", "server", "rate_limit"]);
    expect(inspect(log.mock.calls)).not.toMatch(/private-token|private\.example|Content-Type|--include/);
  } finally {
    log.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
