import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { parseRun } from "../src/runs/service";
import { emptySummary } from "../src/runs/fold";
import { releasable, type ReleaseCandidate } from "../src/runs/capacity";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sources(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []);
}

describe("retired automation stays removed", () => {
  it("has no retired module or environment setting reads in API sources", () => {
    const violations: string[] = [];
    for (const path of sources(new URL("../src", import.meta.url).pathname)) {
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        // Covers static imports, exports, dynamic imports and require(), as well as
        // computed environment access and settings passed through a helper.
        if (ts.isStringLiteralLike(node) || ts.isIdentifier(node)) {
          const value = node.text;
          if (value.startsWith("GOND_AGENT_CI_") || /(?:^|\/)ci-watch(?:\.[cm]?[jt]s)?$/.test(value))
            violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(path).not.toMatch(/\/ci-watch\.[cm]?[jt]s$/);
    }
    expect(violations).toEqual([]);
  });

  it("parseRun ignores legacy message metadata but preserves file dictionaries and recovery controls", () => {
    const message = { id: "message", text: "Continue", images: [] };
    const normal = { backend: "builtin", pending: [message], active_message: message, recovery_task: message,
      auto_resume_pending: true, resume_from_checkpoint: true, recovery_phase: "finishing",
      summary: { ...emptySummary(), files: { "ci_config.ts": { additions: 1, deletions: 0 } } } };
    const legacyMessage = { ...message, source: "ci", ci_turn: true };
    expect(parseRun(JSON.stringify({ ...normal, pending: [legacyMessage], active_message: legacyMessage,
      recovery_task: legacyMessage }))).toEqual(parseRun(JSON.stringify(normal)));
  });

  it("parseRun ignores old ci_* fields without changing completion or idle release", () => {
    const normal = { backend: "builtin", status: "ready", phase: "agent", pending: [], summary: emptySummary(),
      pushed: true, head_sha: "a".repeat(40), base_sha: "b".repeat(40), pr_state: "open",
      auto_resume_pending: false, resume_from_checkpoint: false };
    const legacy = { ...normal, ci_active: true, ci_turn: true, ci_publication_pending: true, ci_round: 2,
      ci_state: "pending", ci_sha: "c".repeat(40), ci_previous_sha: "d".repeat(40), ci_pending_sha: "e".repeat(40),
      ci_cancelled_sha: "f".repeat(40), ci_failing: ["test"], ci_reason: "old reason", ci_future_field: { ignored: true } };
    const stored = JSON.stringify(legacy);
    const parsed = parseRun(stored);
    expect(parsed).toEqual(parseRun(JSON.stringify(normal)));
    expect(JSON.parse(stored)).toEqual(legacy); // No migration or in-place storage rewrite.
    const candidate: ReleaseCandidate = { run: parsed, live: true, busy: false, closing: false, booting: false,
      publicationPending: false, checkpointClaimed: false, idleSince: 0, delayMs: 120_000,
      state: { head: normal.head_sha, clean: true } };
    expect(releasable(candidate, 180_000)).toBe(true);
  });
});
