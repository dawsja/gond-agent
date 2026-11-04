// Presentation only: stored events and the worker's tool identities stay unchanged.
// For compact labels only; expanded details keep the original text.
export const displayText = (value: string) => value.replace(/[\p{Cc}\p{Cf}]|[\u{E0000}-\u{E007F}]|[\uFE00-\uFE0F]|[\u{E0100}-\u{E01EF}]/gu, "");
const aliases: Record<string, string> = {
  Read: "read", Write: "write", Edit: "edit", MultiEdit: "multi_edit",
  Bash: "bash", Grep: "grep", Glob: "glob", WebSearch: "web_search", WebFetch: "web_fetch",
  TodoWrite: "update_plan", Agent: "task", Task: "task",
  commandExecution: "bash", fileChange: "apply_patch",
};
const labels: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", multi_edit: "Edit", apply_patch: "Patch",
  bash: "Command", kill_shell: "Stop command", bash_output: "Command output",
  glob: "Find files", grep: "Search", list_directory: "List files", symbols: "Find symbols",
  batch: "Review files", list_plan: "Read plan", web_search: "Search the web", web_fetch: "Read page",
  browser: "Browser check", run_checks: "Run checks", skill: "Read instructions",
  update_plan: "Plan update", task: "Delegate work",
};
export const EDIT_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch"]);
export const EXPLORE_TOOLS = new Set(["read", "glob", "grep", "symbols", "batch", "list_directory", "list_plan", "web_search", "web_fetch", "bash_output"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const words = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
export const toolLabel = (name: string) => labels[name] ?? (words(name).replace(/^\w/, c => c.toUpperCase()) || "Activity");

export function presentTool(rawName: string, rawTitle: string, rawInput: unknown) {
  const item = record(rawInput);
  let name = rawName, source: string | undefined, input = item;
  if (name === "mcpToolCall") {
    name = text(item.tool) || "external";
    source = text(item.server) || undefined;
    input = record(item.arguments);
    if (typeof item.arguments === "string") {
      try { input = record(JSON.parse(item.arguments)); } catch { /* Older events may lack structured arguments. */ }
    }
  }
  const scoped = /^mcp__(.+?)__(.+)$/.exec(name);
  if (scoped) { source = scoped[1]; name = scoped[2]; }
  const local = !source || source === "gond";
  name = aliases[name] ?? name;
  const label = toolLabel(name);
  const paths = [text(input.path) || text(input.file_path), ...(
    Array.isArray(input.changes) ? input.changes.map(change => text(record(change).path)) : []
  )].filter(Boolean);
  const patch = text(input.patch);
  if (patch) for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1].trim());
  const detail = paths[0] || text(input.command) || text(input.pattern) || text(input.query) || text(input.url) || text(input.skill);
  const transportTitle = !rawTitle || rawTitle === rawName || rawTitle === text(item.tool) || rawTitle === "mcpToolCall";
  const title = (detail || (transportTitle ? "" : rawTitle)).slice(0, 500);
  return { name: local ? name : "external", label, title, paths: [...new Set(paths)], source: local ? undefined : words(source!) };
}

interface Activity { name: string; label: string; title: string; status: "running" | "done" | "failed"; paths: string[]; summary?: string }

// run_checks emits raw stdout, not its model-facing JSON result. The shell's
// terminal summary is a duration only for exit 0 (runner/src/tools/bash.rs).
// Report process status, never a verification verdict (even `true` exits 0).
// Background launches and legacy completions without this signal stay Finished.
function checkResult(tool: Activity): string | undefined {
  const summary = tool.summary ?? ""
  if (tool.status === "done" && /^\d+\.\d+s$/.test(summary)) return "exit 0"
  const exit = /^exit (-?\d+) · \d+\.\d+s$/.exec(summary)
  return tool.status === "failed" && exit && exit[1] !== "0" ? `exit ${exit[1]}` : undefined
}
export function activityLabel(tool: Activity) {
  const running = tool.status === "running", failed = tool.status === "failed";
  if (tool.name === "bash") {
    const kind = /\btypecheck\b|\btsc\b/.test(tool.title) ? "Typecheck" : /\b(?:test|vitest|pytest)\b/.test(tool.title) ? "Tests" : /\bbuild\b/.test(tool.title) ? "Build" : "Command";
    return running ? `Running ${kind.toLowerCase()}` : `${kind} ${failed ? "failed" : "finished"}`;
  }
  if (tool.name === "run_checks") {
    const result = checkResult(tool)
    return running ? "Running checks" : `${failed ? "Checks failed" : "Checks finished"}${result ? ` · ${result}` : ""}`
  }
  if (tool.name === "browser") return running ? "Checking browser layouts" : `Browser checks ${failed ? "failed" : "finished"}`;
  if (tool.name === "update_plan") return running ? "Updating plan" : failed ? "Plan update failed" : "Updated plan";
  if (tool.name === "read") return `${running ? "Reading" : failed ? "Couldn't read" : "Read"}${tool.title ? ` ${tool.title}` : " file"}`;
  if (EXPLORE_TOOLS.has(tool.name)) return running ? "Reviewing files and context" : failed ? "Couldn't finish reviewing context" : "Reviewed context";
  return `${tool.label} ${running ? "in progress" : failed ? "failed" : "finished"}`;
}

export function groupLabel(tools: Activity[], edits = false) {
  const failed = tools.some(t => t.status === "failed"), running = tools.some(t => t.status === "running");
  if (edits) {
    const paths = new Set(tools.flatMap(t => t.paths));
    if (failed) return "Couldn't finish updating files";
    if (!paths.size) return running ? "Updating files" : `Made ${tools.length} ${tools.length === 1 ? "edit" : "edits"}`;
    return `${running ? "Updating" : "Updated"} ${paths.size} ${paths.size === 1 ? "file" : "files"}`;
  }
  if (failed) return "Couldn't finish reviewing context";
  if (running) return activityLabel(tools.findLast(t => t.status === "running")!);
  const reads = tools.filter(t => t.name === "read");
  const files = new Set(reads.map(t => t.paths[0] || t.title)).size;
  const searches = tools.filter(t => ["glob", "grep", "symbols", "web_search"].includes(t.name)).length;
  const parts = [files ? `Viewed ${files} ${files === 1 ? "file" : "files"}` : "", searches ? `${files ? "ran" : "Ran"} ${searches} ${searches === 1 ? "search" : "searches"}` : ""].filter(Boolean);
  return parts.join(" and ") || "Reviewed context";
}
