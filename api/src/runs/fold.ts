// Folds the agent event stream (protocol/README.md) into the summary a run row shows, and merges
// streaming deltas so the stored transcript has one row per burst instead of one per token.

export type RunStatus = "queued" | "working" | "ready" | "merged" | "failed" | "stopped";

export type Ev = { type: string; [k: string]: any };

export interface Summary {
  step: string | null;
  plan_done: number;
  plan_total: number;
  /** Per-file line counts from the agent's own edits; replaced by git numstat after each commit. */
  files: Record<string, { add: number; del: number }>;
  /** The main agent's text in the current turn: the pull request description when the turn ends. */
  text: string;
  error: string | null;
}

export const emptySummary = (): Summary => ({
  step: null,
  plan_done: 0,
  plan_total: 0,
  files: {},
  text: "",
  error: null,
});

const VERB: Record<string, string> = {
  read: "Reading",
  list_directory: "Listing",
  glob: "Finding",
  grep: "Searching",
  symbols: "Navigating",
  batch: "Reading",
  browser: "Testing browser",
  finish_review: "Reviewing",
  write: "Writing",
  edit: "Editing",
  multi_edit: "Editing",
  apply_patch: "Patching",
  bash: "Running",
  web_fetch: "Fetching",
  web_search: "Searching the web for",
  task: "Delegating:",
  skill: "Using skill",
};

function stepLabel(name: string, title: string): string {
  const verb = VERB[name] ?? name;
  const s = `${verb} ${title}`.trim();
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** Counts files and +/- lines in a unified diff. */
export function diffStat(diff: string): Record<string, { add: number; del: number }> {
  const out: Record<string, { add: number; del: number }> = {};
  let cur: { add: number; del: number } | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "").trim();
      cur = path === "/dev/null" ? null : (out[path] ??= { add: 0, del: 0 });
    } else if (line.startsWith("--- ")) {
      continue;
    } else if (cur && line.startsWith("+")) {
      cur.add++;
    } else if (cur && line.startsWith("-")) {
      cur.del++;
    }
  }
  return out;
}

export function fold(s: Summary, ev: Ev): Summary {
  const main = ev.agent_id === "main";
  switch (ev.type) {
    case "turn.start":
      return main ? { ...s, text: "", error: null } : s;
    case "text.delta":
      return main ? { ...s, text: s.text + ev.text } : s;
    case "tool.start":
      return { ...s, step: stepLabel(ev.name, ev.title ?? "") };
    case "todos": {
      if (!main) return s;
      const items = (ev.items ?? []) as { status: string }[];
      return { ...s, plan_total: items.length, plan_done: items.filter((i) => i.status === "done").length };
    }
    case "tool.end": {
      if (!ev.diff) return s;
      const files = { ...s.files };
      for (const [path, d] of Object.entries(diffStat(ev.diff))) {
        const prev = files[path] ?? { add: 0, del: 0 };
        files[path] = { add: prev.add + d.add, del: prev.del + d.del };
      }
      return { ...s, files };
    }
    case "error":
      return main ? { ...s, error: ev.message } : s;
    default:
      return s;
  }
}

export function totals(s: Summary) {
  const f = Object.values(s.files);
  return { files: f.length, additions: f.reduce((n, x) => n + x.add, 0), deletions: f.reduce((n, x) => n + x.del, 0) };
}

/** Streaming deltas that can be merged into the previous event of the same kind. */
export function mergeKey(ev: Ev): string | null {
  switch (ev.type) {
    case "text.delta":
    case "reasoning.delta":
      return `${ev.type}:${ev.agent_id}`;
    case "tool.output":
      return `${ev.type}:${ev.agent_id}:${ev.call_id}`;
    default:
      return null;
  }
}

export function merge(into: Ev, ev: Ev): Ev {
  return ev.type === "tool.output" ? { ...into, chunk: into.chunk + ev.chunk } : { ...into, text: into.text + ev.text };
}

/** A short PR / branch title from the task text. */
export function titleFrom(prompt: string): string {
  const line = (prompt.trim().split("\n")[0] ?? "").replace(/\s+/g, " ");
  return line.length > 72 ? `${line.slice(0, 71).trimEnd()}…` : line || "Untitled task";
}

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "task"
  );
}
