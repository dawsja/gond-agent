// Unified diffs, parsed and drawn with light highlighting (the web app's run page).
import type { ReactNode } from "react"
import { mono } from "./theme"
import { cn } from "./utils"

export type DiffLine = { t: "add" | "del" | "ctx" | "hunk"; o?: number; n?: number; s: string }

const KW =
  /\b(import|from|export|const|let|async|await|function|return|if|else|new|class|type|interface|extends|implements|throw|try|catch|describe|it|expect)\b/
const TOKEN =
  /(\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:_\d+)*\b|\b[A-Z][A-Za-z0-9]+\b|\b[a-z_][A-Za-z0-9_]*(?=\()|\b(?:import|from|export|const|let|async|await|function|return|if|else|new|class|type|interface|extends|implements|throw|try|catch|describe|it|expect)\b)/g

/** A deliberately small highlighter in the theme's --syn-* colors (each app's index.css, dark-only). */
export function highlight(src: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of src.matchAll(TOKEN)) {
    const tok = m[0]
    const at = m.index ?? 0
    if (at > last) out.push(src.slice(last, at))
    let color: string
    if (tok.startsWith("//")) color = "var(--subtle)"
    else if (/^["'`]/.test(tok)) color = "var(--syn-string)"
    else if (/^\d/.test(tok)) color = "var(--syn-number)"
    else if (KW.test(tok) && /^[a-z]/.test(tok)) color = "var(--syn-keyword)"
    else if (/^[A-Z]/.test(tok)) color = "var(--syn-type)"
    else color = "var(--syn-fn)"
    out.push(
      <span key={i++} style={{ color, fontStyle: tok.startsWith("//") ? "italic" : undefined }}>
        {tok}
      </span>,
    )
    last = at + tok.length
  }
  if (last < src.length) out.push(src.slice(last))
  return out
}

export function DiffView({ lines, className, gutter = true }: { lines: DiffLine[]; className?: string; gutter?: boolean }) {
  return (
    <div className={cn("text-[12px] leading-[20px]", className)} style={mono}>
      {lines.map((l, idx) => {
        if (l.t === "hunk")
          return (
            <div key={idx} className="flex bg-raised/60 text-muted-foreground">
              {gutter && <span className="w-[72px] shrink-0" />}
              <span className="min-w-0 truncate whitespace-pre px-3">{l.s}</span>
            </div>
          )
        const bg = l.t === "add" ? "bg-diff-add-line" : l.t === "del" ? "bg-diff-del-line" : ""
        const gbg = l.t === "add" ? "bg-diff-add-gutter" : l.t === "del" ? "bg-diff-del-gutter" : ""
        const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " "
        const signColor = l.t === "add" ? "text-diff-add" : l.t === "del" ? "text-diff-del" : "text-transparent"
        return (
          <div key={idx} className={cn("flex", bg)}>
            {gutter && (
              <span className={cn("flex w-[72px] shrink-0 select-none text-right text-[11px] text-subtle", gbg)}>
                <span className="w-9 pr-2">{l.o ?? ""}</span>
                <span className="w-9 pr-2">{l.n ?? ""}</span>
              </span>
            )}
            <span className={cn("w-5 shrink-0 select-none text-center", signColor)}>{sign}</span>
            <span className="min-w-0 flex-1 whitespace-pre pr-3">{highlight(l.s)}</span>
          </div>
        )
      })}
    </div>
  )
}

export interface FileDiff {
  path: string
  /** A added · M modified · D deleted · R renamed */
  status: "A" | "M" | "D" | "R"
  add: number
  del: number
  lines: DiffLine[]
}

/**
 * Parses unified diffs: `git diff` output (with `diff --git` headers) or the agent's per-edit diffs
 * (just `---`/`+++` and hunks). Several diffs of the same file are merged in order.
 */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const files = new Map<string, FileDiff>()
  let cur: FileDiff | null = null
  let oldPath = ""
  let pending: Partial<FileDiff> = {}
  let o = 0
  let n = 0
  const open = (path: string, status: FileDiff["status"]) => {
    cur = files.get(path) ?? { path, status, add: 0, del: 0, lines: [] }
    if (!files.has(path)) files.set(path, cur)
    else if (status === "A" || status === "D") cur.status = status
  }
  // Lines left in the current hunk (old side, new side): inside a hunk, "--- x" is a deleted "-- x".
  let leftOld = 0
  let leftNew = 0
  for (const raw of text.split("\n")) {
    const file = cur as FileDiff | null
    if (file && (leftOld > 0 || leftNew > 0)) {
      if (raw.startsWith("+")) {
        file.lines.push({ t: "add", n: n++, s: raw.slice(1) })
        file.add++
        leftNew--
      } else if (raw.startsWith("-")) {
        file.lines.push({ t: "del", o: o++, s: raw.slice(1) })
        file.del++
        leftOld--
      } else if (raw.startsWith(" ") || raw === "") {
        file.lines.push({ t: "ctx", o: o++, n: n++, s: raw.slice(1) })
        leftOld--
        leftNew--
      }
      continue
    }
    if (raw.startsWith("diff --git ")) {
      cur = null
      pending = {}
      continue
    }
    if (raw.startsWith("new file mode")) pending.status = "A"
    else if (raw.startsWith("deleted file mode")) pending.status = "D"
    else if (raw.startsWith("rename to ")) pending.status = "R"
    if (raw.startsWith("--- ")) {
      oldPath = raw.slice(4).replace(/^a\//, "").trim()
      continue
    }
    if (raw.startsWith("+++ ")) {
      const newPath = raw.slice(4).replace(/^b\//, "").trim()
      const deleted = newPath === "/dev/null"
      open(deleted ? oldPath : newPath, pending.status ?? (oldPath === "/dev/null" ? "A" : deleted ? "D" : "M"))
      continue
    }
    if (!file) continue
    const h = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (h) {
      o = Number(h[1])
      n = Number(h[3])
      leftOld = h[2] === undefined ? 1 : Number(h[2])
      leftNew = h[4] === undefined ? 1 : Number(h[4])
      file.lines.push({ t: "hunk", s: raw })
    }
  }
  return [...files.values()]
}
