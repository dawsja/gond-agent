import { createHmac } from "node:crypto";
import { canonicalEvidence, type EvidenceRecord } from "../../src/runs/evidence";

export const evidenceSigningKey = Buffer.alloc(32, 7);
export const evidenceTree = "a".repeat(40);
export const unverifiedBlock = "<!-- gond-agent:verification:start -->\n## Verification\n\nNot verified.\nNo authenticated execution evidence is available.\nVerification gate and policy source: unavailable.\n\n### Not verified\n```text\nNo fresh successful check with a positive parsed test count.\n```\n\n### Evidence weakened\nNo test or policy weakening warnings recorded; absence of warnings is not proof of coverage.\n\nEnvironment evidence describes an allow-list and its digest, not proof that no secrets were available. HOME and .npmrc may still expose credentials or configuration.\n<!-- gond-agent:verification:end -->";
export const unavailableReviewBlock = "## Adversarial review\n\nReviewer skipped: review status unavailable.\nFindings considered: 0; valid: 0; unconfirmed: 0; dropped: 0.\n\nOnly separate-container fail/assertion → patch/pass reproductions count. Review assistance is not a correctness guarantee. Executed repository code has ordinary container network access; same-UID code is not isolated from the runner.";
export const unverifiedDescription = (body: string) => `${body ? `${body}\n\n` : ""}${unverifiedBlock}\n\n${unavailableReviewBlock}`;
export function signedRecord(patch: Partial<EvidenceRecord> = {}, key: Buffer = evidenceSigningKey): EvidenceRecord {
  const { sig: _sig, ...record } = {
    run_id: "run", command_definition_changed: false,
    seq: 1, id: "00000000-0000-4000-8000-000000000001", command: "npm test", cwd: ".", exit_code: 0,
    duration_ms: 25, started_at: 1700000000000, tree_hash_before: evidenceTree, tree_hash_after: evidenceTree,
    tests_ran: 3, env_clean: true, env_digest: "b".repeat(64), output_tail: "3 tests passed", kind: { type: "check" as const },
    ...patch,
  };
  return { ...record, sig: createHmac("sha256", key).update(canonicalEvidence({ domain: "gond-agent:evidence:v1", run_id: record.run_id, record })).digest("hex") };
}
export function evidenceState(key: string | null = evidenceSigningKey.toString("hex")) {
  return { state: { evidence: {
    key, records: [], policy: { enabled: true, checks: [{ command: "npm test", cwd: "." }], ui: "attempt" as const, source: ".gond-agent/checks.json", notes: [], base: evidenceTree },
    gate_rounds: 1, turn_gate_rounds: 1, resumes: 0, unverified: ["UI attempt not recorded."],
  } } };
}
