import type { Item, ToolCall } from "./transcript"
import { displayText, EDIT_TOOLS, EXPLORE_TOOLS } from "./tool-presentation"

export interface ActivityGroup {
  kind: "activity-group"
  key: string
  activity: "commands" | "edits" | "explore"
  tools: ToolCall[]
  expansionKeys: string[]
  label: string
  detail: string
  failed: number
}
export type TimelineItem = (Item & { expansionKey?: string }) | ActivityGroup

/** Presentation only. Keep separators, saved items and tool objects untouched.
 * IDs depend on the first call, never the batch size or completion timestamp:
 * React/Radix can retain an open disclosure as completed steps append.
 */
export function groupTranscriptItems(items: readonly Item[]): TimelineItem[] {
  const result: TimelineItem[] = []
  for (const item of items) {
    const tools = item.kind === "tool" ? [item.tool] : item.kind === "explore" || item.kind === "edits" ? item.tools : undefined
    if (!tools?.length) { result.push(item); continue }
    for (const tool of tools) {
      const activity = tool.name === "bash" ? "commands" : EDIT_TOOLS.has(tool.name) ? "edits" : EXPLORE_TOOLS.has(tool.name) ? "explore" : undefined
      const complete = tool.status === "done" || tool.status === "failed"
      // Missing historical metadata and unknown/external tools keep the old row.
      if (!activity || !complete || !tool.callId || tool.source || !Array.isArray(tool.paths) || (activity === "commands" && !tool.title) || (activity === "edits" && !tool.paths.length)) {
        const standalone: Item = item.kind === "tool" || (tools.length === 1 && tool.status !== "running") ? item : { kind: "tool", key: `step:${tool.callId}`, tool }
        result.push(activity && !tool.source && tool.callId && tool.status === "running"
          ? { ...standalone, expansionKey: `activity:${activity}:${tool.callId}` }
          : standalone)
        continue
      }
      const previous = result.at(-1)
      const group: ActivityGroup = previous?.kind === "activity-group" && previous.activity === activity
        ? previous
        : { kind: "activity-group", key: `activity:${activity}:${tool.callId}`, activity, tools: [], expansionKeys: [], label: "", detail: "", failed: 0 }
      if (group !== previous) result.push(group)
      group.tools.push(tool)
      // Retain disclosure state even when out-of-order completions merge groups.
      group.expansionKeys.push(`activity:${activity}:${tool.callId}`)
      if (tool.status === "failed") group.failed++
    }
  }
  for (const item of result) {
    if (item.kind !== "activity-group") continue
    const files = new Set(item.tools.flatMap(tool => tool.paths)).size
    const count = files || item.tools.length
    const detail = item.tools.find(tool => tool.status === "failed") ?? item.tools.find(tool => tool.paths[0] || tool.title)
    item.detail = displayText(detail?.paths[0] || detail?.title || "")
    item.label = item.activity === "commands" ? `Ran ${item.tools.length} ${item.tools.length === 1 ? "command" : "commands"}`
      : item.activity === "edits" ? `Edited ${files} ${files === 1 ? "file" : "files"}`
      : files ? `Explored ${files} ${files === 1 ? "file" : "files"}` : `Explored context · ${count} ${count === 1 ? "step" : "steps"}`
  }
  return result
}
