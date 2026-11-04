import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const text = (bytes: number) => z.string().max(bytes).refine(s => Buffer.byteLength(s) <= bytes && !/[\uD800-\uDFFF]/u.test(s), "Invalid UTF-8 text");
const hash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const cwd = text(1024).refine(s => s === "." || (!!s && !s.startsWith("/") && !s.includes("\\") && s.split("/").every(p => p && p !== "." && p !== "..") && !/[\x00-\x1f\x7f]/.test(s)));
const check = z.strictObject({ command: text(8192), cwd });
const policySchema = z.strictObject({ enabled: z.boolean(), checks: z.array(check).max(128), ui: z.enum(["attempt", "none"]), source: text(2048), notes: z.array(text(1024)).max(32), base: hash.or(z.literal("")) });
export const evidenceRecordSchema = z.strictObject({
  seq: uint, id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
  command: text(8192), cwd, exit_code: z.number().int().min(-2147483648).max(2147483647).nullable(),
  duration_ms: uint, started_at: uint, tree_hash_before: hash.or(z.literal("")), tree_hash_after: hash.or(z.literal("")),
  tests_ran: uint.nullable(), env_clean: z.boolean(), env_digest: z.string().regex(/^[a-f0-9]{64}$/), output_tail: text(4096),
  kind: z.discriminatedUnion("type", [z.strictObject({ type: z.literal("check") }), z.strictObject({ type: z.literal("ui_attempt"), url: text(4096), title: text(1024) })]),
  sig: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export interface Evidence {
  records: EvidenceRecord[];
  last_seq: number;
  ids: string[];
  policy?: z.infer<typeof policySchema>;
  gate_rounds?: number;
  /** Crash-safe reservation: up to two rounds are charged before task delivery. */
  gate_budget?: number;
  turn_gate_rounds?: number;
  resumes?: number;
  unverified?: string[];
  publication_tree?: string;
  weakened?: string[];
  ui_required?: boolean;
  docs_only?: boolean;
  recorded_before_restart?: string[];
}
export const emptyEvidence = (): Evidence => ({ records: [], last_seq: 0, ids: [] });

/** serde_json::Value uses a lexically sorted map, recursively, without whitespace. */
export function canonicalEvidence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalEvidence((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Returns a new bounded public snapshot; never puts a signing key into run data. */
export function acceptEvidence(current: Evidence | undefined, value: unknown, key: Buffer | undefined): Evidence | undefined {
  if (!key || key.length !== 32) return;
  const parsed = evidenceRecordSchema.safeParse(value);
  if (!parsed.success) return;
  const record = parsed.data, state = current ?? emptyEvidence();
  if (record.seq <= state.last_seq || state.ids.length >= 4096 || state.ids.includes(record.id.toLowerCase())) return;
  const { sig, ...unsigned } = record;
  const expected = createHmac("sha256", key).update(canonicalEvidence(unsigned)).digest();
  if (!timingSafeEqual(expected, Buffer.from(sig, "hex"))) return;
  return { ...state, records: [...state.records, record].slice(-40), last_seq: record.seq, ids: [...state.ids, record.id.toLowerCase()] };
}

/** The private export_state RPC returns {state: ...}; tolerate only absent legacy replies. */
export function exportedEvidence(reply: unknown): Record<string, unknown> | undefined {
  if (!reply || typeof reply !== "object") return;
  let state = (reply as { state?: unknown }).state;
  if (typeof state === "string") {
    if (Buffer.byteLength(state) > 4 * 1024 * 1024) return;
    try { state = JSON.parse(state); } catch { return; }
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) return;
  const evidence = (state as { evidence?: unknown }).evidence;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) return evidence as Record<string, unknown>;
}
export function evidenceKey(reply: unknown): Buffer | undefined {
  const key = exportedEvidence(reply)?.key;
  if (typeof key === "string" && /^[a-f0-9]{64}$/.test(key)) return Buffer.from(key, "hex");
}
export function finishEvidence(current: Evidence | undefined, reply: unknown, key: Buffer | undefined): Evidence {
  // Missing/malformed finish replies cannot replenish a run-wide gate budget.
  const state: Evidence = { ...(current ?? emptyEvidence()), policy: undefined, turn_gate_rounds: undefined, unverified: key || current?.records.length ? ["Verification policy status unavailable."] : [] };
  const evidence = exportedEvidence(reply);
  // A later key is never adopted, and metadata from a changed-key worker is ignored.
  if (!evidence || (key && evidence.key !== key.toString("hex"))) return state;
  const policy = policySchema.safeParse(evidence.policy);
  const notes = z.array(text(1024)).max(64).safeParse(evidence.unverified);
  const rounds = uint.max(4294967295).safeParse(evidence.gate_rounds);
  const turnRounds = uint.max(4294967295).safeParse(evidence.turn_gate_rounds);
  const resumes = uint.max(4294967295).safeParse(evidence.resumes);
  const historical = z.array(z.string().uuid()).max(40).safeParse(evidence.historical_ids ?? []);
  // Preserve valid private counters even if policy metadata is incompatible.
  if (rounds.success) state.gate_rounds = Math.max(state.gate_rounds ?? 0, rounds.data);
  if (resumes.success) state.resumes = Math.max(state.resumes ?? 0, resumes.data);
  if (!policy.success || !notes.success || !rounds.success || !turnRounds.success || !resumes.success || !historical.success) return state;
  return { ...state, policy: policy.data, unverified: key ? notes.data : ["Signing key unavailable; execution evidence not accepted.", ...notes.data], turn_gate_rounds: turnRounds.data,
    recorded_before_restart: [...new Set([...(state.recorded_before_restart ?? []), ...historical.data])].slice(-40) };
}

export function cleanEvidenceText(value: string): string {
  return value.replace(/[\p{Cf}\u{E0000}-\u{E007F}\uFE00-\uFE0F\u{E0100}-\u{E01EF}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu, "");
}
function bounded(value: string, limit: number) {
  const clean = cleanEvidenceText(value);
  return clean.length > limit ? `${clean.slice(0, limit)}\n[truncated]` : clean;
}
function fenced(value: string) {
  const clean = cleanEvidenceText(value);
  const longest = (char: string) => Math.max(2, ...Array.from(clean.matchAll(new RegExp(`${char}+`, "g")), m => m[0].length));
  const char = longest("`") <= longest("~") ? "`" : "~";
  const fence = char.repeat(longest(char) + 1);
  return `${fence}text\n${clean}\n${fence}`;
}
export const VERIFICATION_START = "<!-- gond-agent:verification:start -->";
export const VERIFICATION_END = "<!-- gond-agent:verification:end -->";

/** Treat all selected prose as untrusted, including explicit descriptions. */
export function neutralizeVerification(body: string): string {
  let result = bounded(body, 20000)
    .replace(/<!--\s*gond-agent:verification:start\s*-->[\s\S]*?(?:<!--\s*gond-agent:verification:end\s*-->|$)/gi, "")
    .replace(/<!--\s*gond-agent:verification:[^>]*-->/gi, "")
    .replace(/\bverification\b/gi, "Model-reported checks (unverified)")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;").slice(0, 20000);
  // Close any unclosed model fence, so it cannot swallow the service-owned block.
  let open: { char: string; count: number } | undefined;
  for (const line of result.split("\n")) {
    const match = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!open) open = { char: match[1][0], count: match[1].length };
    else if (match[1][0] === open.char && match[1].length >= open.count && !match[2].trim()) open = undefined;
  }
  if (open) result += `\n${open.char.repeat(open.count)}`;
  return result;
}

export function verificationBlock(evidence?: Evidence): string {
  const records = evidence?.records ?? [];
  const fresh = (r: EvidenceRecord) => !evidence?.recorded_before_restart?.includes(r.id) && !!evidence?.publication_tree && r.tree_hash_before === evidence.publication_tree && r.tree_hash_after === evidence.publication_tree;
  const latest = new Map<string, EvidenceRecord>();
  for (const record of records) if (record.kind.type === "check") latest.set(JSON.stringify([record.cwd, record.command]), record);
  const successful = (r: EvidenceRecord) => r.exit_code === 0 && r.env_clean && r.tests_ran !== null && r.tests_ran > 0;
  const passed = [...latest.values()].filter(r => fresh(r) && successful(r));
  const lines = [VERIFICATION_START, "## Verification", "", passed.length ? `${passed.length} fresh successful check(s): evidence recorded by the worker, not independent proof or review.` : "Not verified."];
  if (!records.length) lines.push("No authenticated execution evidence is available.");
  else lines.push(`Failed or inconclusive checks: ${[...latest.values()].filter(r => !successful(r)).length}. Stale records: ${records.filter(r => !fresh(r)).length}. Zero-test checks: ${[...latest.values()].filter(r => r.tests_ran === 0).length}. Unknown test counts: ${[...latest.values()].filter(r => r.tests_ran === null).length}.`);
  if (evidence?.policy) {
    lines.push("", `Verification gate: ${evidence.policy.enabled ? "on" : "off"}. UI policy: ${evidence.policy.ui}.`, `Gate rounds: ${evidence.gate_rounds ?? 0} total; ${evidence.turn_gate_rounds ?? 0} this turn.`, "Policy source and frozen checks:", fenced(bounded([
      evidence.policy.source, `Pinned base: ${evidence.policy.base || "unavailable"}`, ...evidence.policy.checks.map(c => `${c.cwd}: ${c.command}`), ...evidence.policy.notes,
    ].join("\n"), 4096)));
  } else lines.push("Verification gate and policy source: unavailable.");
  const missing = [...(evidence?.unverified ?? [])];
  if (!passed.length && !evidence?.docs_only) missing.push("No fresh successful check with a positive parsed test count.");
  if (evidence?.docs_only) lines.push("Docs-only change: the check requirement is waived; stale records remain stale.");
  if (evidence?.ui_required !== false && evidence?.policy?.ui === "attempt" && !records.some(r => r.kind.type === "ui_attempt" && fresh(r))) missing.unshift("Missing a fresh UI attempt; a recorded attempt would not prove visual correctness.");
  for (const record of latest.values()) {
    if (record.exit_code !== 0) missing.push(`Failed or unknown exit: ${record.cwd}: ${record.command}`);
    if (record.tests_ran === 0) missing.push(`Failed evidence requirement: zero tests reported (even an exit of 0 does not count): ${record.cwd}: ${record.command}`);
    if (record.tests_ran === null) missing.push(`Failed evidence requirement: test count unknown: ${record.cwd}: ${record.command}`);
    if (!record.env_clean) missing.push(`Environment allow-list not applied: ${record.cwd}: ${record.command}`);
  }
  lines.push("", "### Not verified", missing.length ? fenced(bounded(missing.join("\n"), 4096)) : "Independent correctness and visual correctness are not established by worker evidence.");
  lines.push("", "### Evidence weakened", evidence?.weakened?.length ? fenced(bounded(evidence.weakened.join("\n"), 2048)) : "No test or policy weakening warnings recorded; absence of warnings is not proof of coverage.");
  lines.push("", "Environment evidence describes an allow-list and its digest, not proof that no secrets were available. HOME and .npmrc may still expose credentials or configuration.");
  if (records.length) lines.push("", "Recorded execution summary:", fenced(records.slice(-40).map(record =>
    `#${record.seq} ${JSON.stringify(bounded(record.command, 200))} cwd=${JSON.stringify(bounded(record.cwd, 120))}; exit=${record.exit_code ?? "unknown"}; ${fresh(record) ? "fresh" : "stale"}; tests_ran=${record.tests_ran ?? "unknown"}; duration_ms=${record.duration_ms}`,
  ).join("\n")));
  // Prefer failures (and their failure names/output) over successful noise. Keep PR bodies bounded.
  const priority = (r: EvidenceRecord) => r.kind.type === "check" && !successful(r) ? 0 : r.kind.type === "ui_attempt" ? 1 : 2;
  const ordered = [...records].sort((a, b) => priority(a) - priority(b) || b.seq - a.seq).slice(0, 8);
  let shown = 0;
  for (const record of ordered) {
    const status = record.exit_code === null ? "exit unavailable" : `exit ${record.exit_code}`;
    const freshness = evidence?.recorded_before_restart?.includes(record.id) ? "recorded before restart; re-run required" : fresh(record) ? "fresh" : "stale or tree unavailable";
    const detail = ["", `<details><summary>${record.kind.type === "check" ? "Check" : "UI attempt"}: ${status}; ${freshness}</summary>`, "", fenced([
      `Command: ${bounded(record.command, 1024)}`, `Directory: ${record.cwd}`, `Duration: ${record.duration_ms} ms`, `Started: ${record.started_at} (Unix ms)`,
      `Tests observed: ${record.tests_ran ?? "unknown"}`, `Environment allow-list applied: ${record.env_clean ? "yes" : "no"}; allow-list digest: ${record.env_digest}`,
      ...(record.kind.type === "ui_attempt" ? [`URL: ${bounded(record.kind.url, 512)}`, `Title: ${bounded(record.kind.title, 512)}`, "An attempt is not proof of visual correctness."] : []),
      "Output tail (excerpt):", ...(record.output_tail.length > 1200 ? ["[earlier output omitted]"] : []), bounded(record.output_tail.slice(-1200), 1200),
    ].join("\n")), "", "</details>"].join("\n");
    if (lines.join("\n").length + detail.length > 23000) continue;
    lines.push(detail);
    shown++;
  }
  if (records.length > shown) lines.push("", `${records.length - shown} additional record(s) omitted from this description.`);
  const earlier = Math.max(0, (evidence?.ids.length ?? 0) - records.length);
  if (earlier) lines.push("", `${earlier} earlier record(s) outside the retained detail window.`);
  lines.push(VERIFICATION_END);
  return lines.join("\n");
}

/** Conservative diff warnings, never a claim that edited tests still cover the change. */
export function weakenedEvidence(diff: string): string[] {
  const notes = new Set<string>();
  for (const section of diff.split(/^diff --git /m).slice(1)) {
    const path = (/^.* "?b\/(.+)\n/.exec(section)?.[1] ?? "").replace(/"$/, "").slice(0, 512);
    const removed = section.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---")).map(l => l.slice(1));
    const added = section.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1));
    const testPath = /(?:^|\/)(?:tests?|__tests__|specs?)(?:\/|\.|$)|[._-](?:test|spec)\.[^.]+$/.test(path);
    if (testPath && (section.includes("deleted file mode") || removed.length)) notes.add(`Tests removed or changed: ${path}`);
    if (added.some(l => /\b(?:test|it|describe)\s*\.\s*(?:skip|todo|only)\b|\b(?:xit|xtest|xdescribe|pytest\.mark\.skip|unittest\.skip|[tb]\.Skip(?:f|Now)?)\b|#\s*\[\s*ignore\b/.test(l))) notes.add(`Skipped or narrowed tests added: ${path}`);
    if (/(?:^|\/)package\.json$/.test(path) && removed.some(l => /"(?:test[^" ]*|check[^" ]*|lint[^" ]*|typecheck)"\s*:/.test(l))) notes.add(`Test/check scripts changed: ${path}`);
    const manifestConfig = /(?:^|\/)Cargo\.toml$/.test(path) && /(?:autotests|doctest|harness|\[\[test\]\]|\btest\s*=)/.test(section)
      || /(?:^|\/)pyproject\.toml$/.test(path) && /(?:tool\.(?:pytest|tox|coverage)|\b(?:addopts|testpaths|filterwarnings)\s*=)/.test(section);
    if (manifestConfig || /(?:^|\/)(?:\.github\/workflows\/|\.circleci\/|\.gitlab-ci|Jenkinsfile|(?:vitest|jest|playwright|cypress|pytest|tox|nyc|coverage)[^/]*\.(?:[cm]?[jt]s|json|ini|toml)|conftest\.py)/.test(path)) notes.add(`Test or CI configuration edited: ${path}`);
    if (/(?:^|\/)\.gond-agent(?:\/|\.)|(?:^|\/)GOND_AGENT\.md$/.test(path)) notes.add(`Verification policy edited: ${path}; runner checks remain frozen for this turn.`);
  }
  return [...notes].sort().slice(0, 32);
}
