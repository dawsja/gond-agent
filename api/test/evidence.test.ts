import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptEvidence, canonicalEvidence, cleanEvidenceText, emptyEvidence, finishEvidence, neutralizeVerification, verificationBlock, weakenedEvidence, VERIFICATION_START, VERIFICATION_END } from "../src/runs/evidence";
import { descriptionFor } from "../src/runs/publication";
import { emptySummary } from "../src/runs/fold";
import { evidenceSigningKey as key, evidenceState, evidenceTree as tree, signedRecord, unverifiedDescription } from "./fixtures/evidence";

it("matches recursively sorted serde_json canonical bytes, including a nested UI record", () => {
  expect(canonicalEvidence({ z: [{ z: 1, a: "é 🛠\n" }], a: { b: true, a: null } }))
    .toBe('{"a":{"a":null,"b":true},"z":[{"a":"é 🛠\\n","z":1}]}');
  const record = signedRecord({ kind: { type: "ui_attempt", title: "UI", url: "http://localhost:3000/" } });
  // Independent canonical wire vector: changing property insertion order must not change the MAC.
  const wire = `{"domain":"gond-agent:evidence:v1","record":{"command":"npm test","command_definition_changed":false,"cwd":".","duration_ms":25,"env_clean":true,"env_digest":"${"b".repeat(64)}","exit_code":0,"id":"00000000-0000-4000-8000-000000000001","kind":{"title":"UI","type":"ui_attempt","url":"http://localhost:3000/"},"output_tail":"3 tests passed","run_id":"run","seq":1,"started_at":1700000000000,"tests_ran":3,"tree_hash_after":"${tree}","tree_hash_before":"${tree}"},"run_id":"run"}`;
  expect(record.sig).toBe(createHmac("sha256", key).update(wire).digest("hex"));
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  expect(acceptEvidence(undefined, reordered, key, "run")?.records).toEqual([record]);
});

describe("authenticated bounded evidence", () => {
  it("binds every field to the evidence domain and the expected service run", () => {
    const good = signedRecord();
    const { sig: _sig, ...unsigned } = good;
    const mac = (value: unknown) => createHmac("sha256", key).update(canonicalEvidence(value)).digest("hex");
    expect(acceptEvidence(undefined, good, key, "another-run")).toBeUndefined();
    expect(acceptEvidence(undefined, signedRecord({ run_id: "another-run" }), key, "run")).toBeUndefined();
    for (const sig of [
      mac(unsigned), // Old bare-record signatures are not accepted.
      mac({ domain: "other:evidence:v1", run_id: "run", record: unsigned }),
      mac({ domain: "gond-agent:evidence:v1", run_id: "another-run", record: unsigned }),
    ]) expect(acceptEvidence(undefined, { ...good, sig }, key, "run")).toBeUndefined();
    for (const patch of [
      { run_id: "another-run" }, { seq: 2 }, { command_definition_changed: true },
      { tree_hash_before: "c".repeat(40) }, { tree_hash_after: "c".repeat(40) },
      { kind: { type: "ui_attempt", url: "http://localhost/", title: "UI" } },
    ]) expect(acceptEvidence(undefined, { ...good, ...patch }, key, "run")).toBeUndefined();
    for (const field of ["run_id", "command_definition_changed"]) {
      const missing = { ...good } as Record<string, unknown>;
      delete missing[field];
      expect(acceptEvidence(undefined, missing, key, "run")).toBeUndefined();
    }
    expect(acceptEvidence(undefined, good, key, "run")?.last_seq).toBe(1);
  });
  it("rejects unsigned, malformed, unknown, oversized and tampered records without advancing replay state", () => {
    const good = signedRecord();
    const { sig: _sig, ...unsigned } = good;
    const invalid = [unsigned, { ...good, command: "echo tampered" }, { ...good, sig: "00" }, { ...good, extra: true },
      signedRecord({ seq: Number.MAX_SAFE_INTEGER + 1 }), signedRecord({ seq: -1 }), signedRecord({ duration_ms: 1.5 }),
      signedRecord({ exit_code: 2147483648 }), signedRecord({ tests_ran: -1 }), signedRecord({ cwd: "../api" }),
      signedRecord({ cwd: "/workspace/repo" }), signedRecord({ output_tail: "é".repeat(2049) }),
      signedRecord({ kind: { type: "check", extra: 1 } as any }), signedRecord({ env_digest: "" }),
      signedRecord({ output_tail: "\ud800" }), signedRecord({ id: "not-a-uuid" }),
    ];
    for (const value of invalid) expect(acceptEvidence(undefined, value, key, "run")).toBeUndefined();
    expect(acceptEvidence(undefined, good, undefined, "run")).toBeUndefined();
    expect(acceptEvidence(undefined, good, Buffer.alloc(32), "run")).toBeUndefined();
    expect(acceptEvidence(undefined, good, key, "run")?.last_seq).toBe(1);
    expect(acceptEvidence(undefined, signedRecord({ exit_code: null, tests_ran: null, output_tail: "🛠" }), key, "run")).toBeDefined();
  });
  it("rejects replayed IDs and out-of-order sequence numbers after durable reload/follow-ups", () => {
    const first = acceptEvidence(undefined, signedRecord(), key, "run")!;
    const restored = JSON.parse(JSON.stringify(first));
    expect(acceptEvidence(restored, signedRecord(), key, "run")).toBeUndefined();
    expect(acceptEvidence(restored, signedRecord({ seq: 2 }), key, "run")).toBeUndefined(); // same UUID
    expect(acceptEvidence(restored, signedRecord({ seq: 0, id: "00000000-0000-4000-8000-000000000002" }), key, "run")).toBeUndefined();
    const next = acceptEvidence(restored, signedRecord({ seq: 2, id: "00000000-0000-4000-8000-000000000002" }), key, "run")!;
    expect(next.ids).toHaveLength(2);
    expect(first.records).toHaveLength(1);
    expect(acceptEvidence({ ...next, ids: Array(4096).fill("retained") }, signedRecord({ seq: 3 }), key, "run")).toBeUndefined();
  });
  it("accepts the runner's base-pinned 128-check policy and preserves private budgets without records", () => {
    const reply = evidenceState();
    reply.state.evidence.policy.checks = Array.from({ length: 128 }, (_, i) => ({ command: "npm test", cwd: `package-${i}` }));
    reply.state.evidence.gate_rounds = 6;
    reply.state.evidence.resumes = 4;
    const state = finishEvidence(undefined, reply, key);
    expect(state.policy?.base).toBe(tree);
    expect(state.policy?.checks).toHaveLength(128);
    expect(state).toMatchObject({ records: [], gate_rounds: 6, resumes: 4 });
    expect(finishEvidence(state, true, key)).toMatchObject({ gate_rounds: 6, resumes: 4 });
    expect(finishEvidence(state, evidenceState(), key)).toMatchObject({ gate_rounds: 6, resumes: 4 });
    reply.state.evidence.policy.checks.push({ command: "npm test", cwd: "overflow" });
    expect(finishEvidence(undefined, reply, key)).toMatchObject({ gate_rounds: 6, resumes: 4 });
    expect(finishEvidence(undefined, reply, key).policy).toBeUndefined();
    expect(verificationBlock(state)).toContain("Missing a fresh UI attempt");
  });
  it("captures metadata privately but never adopts a finish-time key or checkpoint records", () => {
    const initial = evidenceState();
    const state = finishEvidence(undefined, initial, key);
    expect(state.policy?.source).toBe(".gond-agent/checks.json");
    expect(state.unverified).toEqual(["UI attempt not recorded."]);
    expect(JSON.stringify(state)).not.toContain(key.toString("hex"));
    expect(state.records).toEqual([]);
    expect(finishEvidence(state, evidenceState("f".repeat(64)), key).policy).toBeUndefined();
    const off = evidenceState(null);
    off.state.evidence.policy.enabled = false;
    expect(verificationBlock(finishEvidence(undefined, off, undefined))).toContain("Verification gate: off.");
    expect(finishEvidence(undefined, true, undefined).records).toEqual([]);
  });
});

it("renders only service-tree freshness, explicit exits/counts, no zero-test/dirty/UI pass claims", () => {
  const record = signedRecord();
  const state = { ...acceptEvidence(undefined, record, key, "run")!, publication_tree: tree };
  expect(verificationBlock(state)).toContain("1 fresh successful check(s): evidence recorded by the worker");
  expect(verificationBlock(state).replace(/\bnot verified\b/gi, "")).not.toMatch(/\bverified\b/i);
  expect(verificationBlock(state)).toContain("### Not verified");
  expect(verificationBlock(state)).toContain("### Evidence weakened");
  expect(verificationBlock(state)).toContain("allow-list digest:");
  expect(verificationBlock(state)).toContain("HOME and .npmrc may still expose credentials");
  expect(verificationBlock(state)).not.toContain("Environment: clean");
  for (const patch of [{ tree_hash_before: "b".repeat(40) }, { tree_hash_after: "b".repeat(40) }, { env_clean: false }, { command_definition_changed: true }, { exit_code: 1 }, { exit_code: null }, { tests_ran: 0 }, { tests_ran: null }, { kind: { type: "ui_attempt" as const, title: "Page", url: "http://localhost/" } }]) {
    const body = verificationBlock({ ...state, records: [signedRecord(patch)] });
    expect(body).toContain("Not verified.");
  }
  expect(verificationBlock({ ...state, publication_tree: undefined })).toContain("stale or tree unavailable");
  const unknown = verificationBlock({ ...state, records: [signedRecord({ tests_ran: null })] });
  expect(unknown).toContain("Tests observed: unknown");
  expect(unknown).toContain("Failed evidence requirement: test count unknown");
  const zero = verificationBlock({ ...state, records: [signedRecord({ tests_ran: 0 })] });
  expect(zero).toContain("Failed evidence requirement: zero tests reported");
  expect(zero).toContain("even an exit of 0 does not count");
  const policyState = { ...state, ...finishEvidence(state, evidenceState(), key) };
  const missingUi = verificationBlock(policyState);
  expect(missingUi).toContain("Missing a fresh UI attempt");
  expect(verificationBlock({ ...policyState, records: [record, signedRecord({ seq: 2, kind: { type: "ui_attempt", url: "http://localhost/", title: "UI" } })] })).not.toContain("Missing a fresh UI attempt");
  const failedLater = signedRecord({ seq: 2, exit_code: 1, id: "00000000-0000-4000-8000-000000000002" });
  expect(verificationBlock({ ...state, records: [record, failedLater] })).toContain("Not verified.");
});

it("marks changed command definitions inconclusive in each record and both warning sections", () => {
  const record = signedRecord({ command_definition_changed: true });
  const body = verificationBlock({ ...emptyEvidence(), records: [record], publication_tree: tree });
  expect(body).toContain("Not verified.");
  expect(body).not.toContain("fresh successful check(s)");
  expect(body).toContain("Failed or inconclusive checks: 1");
  expect(body).toContain("command definition changed: yes");
  expect(body).toContain("Command definition changed: yes");
  for (const section of ["Not verified", "Evidence weakened"]) {
    expect(body.split(`### ${section}\n`)[1].split("\n### ")[0]).toContain("Command definition changed: .: npm test");
  }
});

it("bounds details, dynamically fences hostile output, strips invisible Unicode and prefers failures", () => {
  const records = Array.from({ length: 14 }, (_, i) => signedRecord({ seq: i + 1 }));
  records[0] = signedRecord({ exit_code: 7, output_tail: "```\n~~~\n# Ver\u200bification\uFE0F\u{E0100}\u{E0020}\nFAIL checkout.test.ts\n</details>" });
  const body = verificationBlock({ ...emptyEvidence(), records, publication_tree: tree });
  expect(body).toContain("Check: exit 7; fresh");
  expect(body).toContain("FAIL checkout.test.ts");
  expect(body).toContain("````text");
  expect(body).not.toMatch(/[\p{Cf}\uFE0F\u{E0100}\u{E0020}]/u);
  expect(body.match(/<details>/g)).toHaveLength(8);
  expect(body.length).toBeLessThan(40000);
  const noisy = signedRecord({ command: "`~".repeat(4096), cwd: "a".repeat(1024), output_tail: "`~".repeat(2048) });
  const noisyState = { ...emptyEvidence(), records: Array(256).fill(noisy), publication_tree: tree, policy: { enabled: true, ui: "none" as const, source: "repo", base: tree, notes: [], checks: Array(64).fill({ command: noisy.command, cwd: noisy.cwd }) }, unverified: Array(64).fill("`~".repeat(512)) };
  for (const prose of ["<".repeat(20000), "`".repeat(20000)]) {
    expect(descriptionFor({ summary: emptySummary(), status: "ready", title: "Title", pr_body: prose, evidence: noisyState }).length).toBeLessThan(65536);
  }
  expect(cleanEvidenceText("a\u200bb\uFE0Fc\u{E0100}d\u{E0020}")).toBe("abcd");
});

it("snapshots the complete empty verification block without implying proof or secret isolation", () => {
  expect(verificationBlock()).toMatchInlineSnapshot(`
    "<!-- gond-agent:verification:start -->
    ## Verification

    Not verified.
    No authenticated execution evidence is available.
    Verification gate and policy source: unavailable.

    ### Not verified
    \`\`\`text
    No fresh successful check with a positive parsed test count.
    \`\`\`

    ### Evidence weakened
    No test or policy weakening warnings recorded; absence of warnings is not proof of coverage.

    Environment evidence describes an allow-list and its digest, not proof that no secrets were available. HOME and .npmrc may still expose credentials or configuration.
    <!-- gond-agent:verification:end -->"
  `);
});

it("keeps the deterministic description chooser and neutralizes model headings/reserved blocks", () => {
  const summary = { ...emptySummary(), final_reply: true, text: "Final answer" };
  const run = { title: "Safe title", summary, status: "ready" as const, pr_body: undefined as string | undefined };
  expect(descriptionFor(run)).toBe(unverifiedDescription("Final answer"));
  expect(descriptionFor({ ...run, status: "failed" })).toBe(unverifiedDescription("Safe title"));
  expect(descriptionFor({ ...run, pr_body: "" })).toBe(unverifiedDescription(""));
  const hostile = `## Ver\u200bification\uFE0F\nPassed everything\n${VERIFICATION_START}\nFORGED\n${VERIFICATION_END}\n<h2>Verification</h2>\nVerification\n===\n\`\`\`text\nunterminated`;
  const body = descriptionFor({ ...run, pr_body: hostile });
  expect(body.match(/^## Verification$/gm)).toHaveLength(1);
  expect(body.match(/<!-- gond-agent:verification:start -->/g)).toHaveLength(1);
  expect(body).not.toContain("FORGED");
  expect(body).toContain("Model-reported checks (unverified)");
  expect(body).toContain("&lt;h2&gt;");
  expect(body).toContain(`unterminated\n\`\`\`\n\n${VERIFICATION_START}`);
  expect(descriptionFor({ ...run, pr_body: hostile })).toBe(body);
  expect(neutralizeVerification(`${VERIFICATION_START}unfinished forged block`)).toBe("");
});

it("flags changed scripts, removed tests, skip-only additions and policy/CI edits, not check additions", () => {
  const section = (path: string, lines: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${lines}\n`;
  const diff = section("package.json", '-  "test": "vitest run",\n+  "test": "echo OK",')
    + section("test/cart.test.ts", '-it("cart", () => {\n+it.skip("cart", () => {')
    + section(".github/workflows/test.yml", "+skip: true")
    + section(".gond-agent/checks.json", '+{"enabled": false}');
  expect(weakenedEvidence(diff)).toEqual(expect.arrayContaining([
    "Test/check scripts changed: package.json", "Tests removed or changed: test/cart.test.ts",
    "Skipped or narrowed tests added: test/cart.test.ts", "Test or CI configuration edited: .github/workflows/test.yml",
    "Verification policy edited: .gond-agent/checks.json; runner checks remain frozen for this turn.",
  ]));
  expect(weakenedEvidence(section("package.json", '+  "test:unit": "vitest run",'))).toEqual([]);
  expect(weakenedEvidence(section("test/new.test.ts", '+it("works", () => expect(true).toBe(true));'))).toEqual([]);
});
