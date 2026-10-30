// Search everything from the sidebar's search button: runs, pages and settings, in one dialog in the middle
// of the screen. Styled like the composer's pickers and shared/menu.tsx: 4px corners, border-strong,
// 32px rows, no motion. Arrows move, Enter opens, Esc closes.
import { ArrowUpRight, Settings2, BookOpen, KeyRound, type LucideIcon, Search, Trash2 } from "lucide-react"
import { Dialog } from "radix-ui"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import type { Run } from "@/lib/api"
import { repoName } from "@/lib/format"
import { DOCS_URL } from "@/lib/links"
import { cn } from "@/lib/utils"
import { Dot } from "./parts"

export type SearchPage = { label: string; icon: LucideIcon; to: string }

type Item = {
  id: string
  group: "Runs" | "Pages" | "Settings" | "Help"
  title: string
  detail?: string
  icon: ReactNode
  keywords?: string
  /** An app path, or a full URL opened in a new tab. */
  to: string
}

const SETTINGS: { title: string; to: string; icon: LucideIcon; keywords: string }[] = [
  { title: "Model providers", to: "/settings#providers", icon: Settings2, keywords: "api key url anthropic openai models transcription setup" },
  { title: "Sessions", to: "/settings#sessions", icon: KeyRound, keywords: "sign out revoke devices browsers" },
  { title: "Delete account", to: "/settings#delete", icon: Trash2, keywords: "remove erase close" },
]

const GROUPS: Item["group"][] = ["Runs", "Pages", "Settings", "Help"]

export function SearchDialog({
  open,
  onOpenChange,
  pages,
  runs,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pages: SearchPage[]
  runs: Run[]
}) {
  const navigate = useNavigate()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const list = useRef<HTMLDivElement>(null)

  const items = useMemo<Item[]>(
    () => [
      ...runs.map((r) => ({
        id: `run:${r.id}`,
        group: "Runs" as const,
        title: r.title,
        detail: repoName(r.repo),
        icon: <Dot status={r.status} size={6} />,
        keywords: `${r.repo} ${r.branch} ${r.status} ${r.pr_number ? `#${r.pr_number}` : ""}`,
        to: `/runs/${r.id}`,
      })),
      ...pages.map((p) => ({ id: `page:${p.to}`, group: "Pages" as const, title: p.label, icon: <p.icon className="size-3.5" />, to: p.to })),
      ...SETTINGS.map((s) => ({
        id: `setting:${s.to}`,
        group: "Settings" as const,
        title: s.title,
        icon: <s.icon className="size-3.5" />,
        keywords: s.keywords,
        to: s.to,
      })),
      { id: "help:docs", group: "Help" as const, title: "Gond Agent Docs", icon: <BookOpen className="size-3.5" />, keywords: "help guide", to: DOCS_URL },
    ],
    [pages, runs],
  )

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const hits = words.length
      ? items.filter((it) => {
          const text = `${it.title} ${it.detail ?? ""} ${it.keywords ?? ""} ${it.group}`.toLowerCase()
          return words.every((w) => text.includes(w))
        })
      : // Nothing typed: the latest runs, then everything else.
        [...items.filter((it) => it.group === "Runs").slice(0, 6), ...items.filter((it) => it.group !== "Runs")]
    return GROUPS.flatMap((g) => hits.filter((it) => it.group === g).slice(0, g === "Runs" ? 30 : undefined))
  }, [items, query])

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const change = (o: boolean) => {
    if (o) {
      setQuery("")
      setActive(0)
    }
    onOpenChange(o)
  }
  const choose = (it: Item | undefined) => {
    if (!it) return
    change(false)
    if (/^https?:/.test(it.to)) window.open(it.to, "_blank", "noopener")
    else navigate(it.to)
  }

  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          aria-describedby={undefined}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              const n = shown.length
              if (n) setActive((i) => (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n)
            } else if (e.key === "Enter") {
              e.preventDefault()
              choose(shown[active])
            }
          }}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(460px,calc(100dvh-96px))] w-[600px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[4px] border border-border-strong bg-popover text-foreground"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActive(0)
              }}
              placeholder="Search runs, pages and settings"
              aria-label="Search"
              className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-subtle"
            />
          </div>
          <div ref={list} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {shown.length === 0 ? (
              <p className="px-3 py-10 text-center text-[13px] text-muted-foreground">Nothing matches “{query.trim()}”</p>
            ) : (
              GROUPS.map((g) => {
                const rows = shown.filter((it) => it.group === g)
                if (!rows.length) return null
                return (
                  <div key={g} className="pb-1">
                    <p className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-subtle">{g}</p>
                    {rows.map((it) => {
                      const i = shown.indexOf(it)
                      const external = /^https?:/.test(it.to)
                      return (
                        <button
                          key={it.id}
                          type="button"
                          role="option"
                          aria-selected={i === active}
                          data-index={i}
                          onMouseMove={() => i !== active && setActive(i)}
                          onClick={() => choose(it)}
                          className={cn(
                            "flex h-8 w-full items-center gap-2.5 rounded-[3px] px-2.5 text-left text-[13px] outline-none",
                            i === active ? "bg-raised text-foreground" : "text-muted-foreground",
                          )}
                        >
                          <span className="grid w-4 shrink-0 place-items-center">{it.icon}</span>
                          <span className={cn("min-w-0 flex-1 truncate", i === active && "text-foreground")}>{it.title}</span>
                          {it.detail && <span className="max-w-[40%] shrink-0 truncate text-[12px] text-subtle">{it.detail}</span>}
                          {external && <ArrowUpRight className="size-3.5 shrink-0 text-subtle" />}
                        </button>
                      )
                    })}
                  </div>
                )
              })
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
