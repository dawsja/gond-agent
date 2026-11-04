import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import { gh } from "../src/github";

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
