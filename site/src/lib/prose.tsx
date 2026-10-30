// Markdown in the landing page's look, for /docs and the legal pages: ruled tables, dark code panels with
// a Copy button, and headings with ids so they can be linked (#install).
import { Check, Copy } from "lucide-react"
import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { useCopy } from "@/landing/copy"
import { cn } from "@/lib/utils"

/** The plain text inside rendered Markdown children. */
export function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (isValidElement(node)) return textOf((node as ReactElement<{ children?: ReactNode }>).props.children)
  return ""
}

/** "Slash commands" → "slash-commands" */
export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

const LABEL: Record<string, string> = { sh: "Terminal", json: "JSON", jsonl: "JSONL", md: "Markdown", text: "Text" }

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const { copied, copy } = useCopy(code)
  // Shell blocks show a dim prompt before each command; the copy is just the commands.
  const lines = code.split("\n")
  return (
    <div className="on-dark my-5 overflow-hidden rounded-[4px] border border-(--rule-strong) bg-(--term)">
      <div className="flex h-10 items-center justify-between border-b border-(--rule) bg-(--term-bar) pr-1.5 pl-3.5">
        <span className="text-[0.8125rem] text-(--term-dim)">{LABEL[lang] ?? "Code"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy"}
          className="flex h-8 items-center gap-1.5 rounded-[2px] px-2 text-[0.8125rem] font-medium text-(--term-fg) transition-colors hover:text-(--term-bright)"
        >
          {copied ? <Check aria-hidden className="size-3.5" strokeWidth={2.25} /> : <Copy aria-hidden className="size-3.5" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className={cn("overflow-x-auto p-3.5 font-mono text-[13px] leading-[1.65] text-(--term-fg)", lang === "sh" && "break-words whitespace-pre-wrap")}>
        {lang === "sh"
          ? lines.map((l, i) => (
              <div key={i}>
                {l.startsWith("#") ? (
                  <span className="text-(--term-dim2)">{l}</span>
                ) : (
                  <>
                    {l && <span className="select-none text-(--term-dim2)">$ </span>}
                    {l}
                  </>
                )}
              </div>
            ))
          : code}
      </pre>
    </div>
  )
}

function heading(level: 2 | 3) {
  return function Heading({ children }: { children?: ReactNode }) {
    const id = slug(textOf(children))
    const Tag = level === 2 ? "h2" : "h3"
    return (
      <Tag id={id} className={level === 2 ? "t-h3 mt-14 mb-3 scroll-mt-24" : "mt-8 mb-2 scroll-mt-24 text-[1.125rem] font-semibold tracking-[-0.015em]"}>
        {children}
      </Tag>
    )
  }
}

const text = "text-[1.0625rem] leading-[1.65] text-(--ink-2) [&_strong]:font-medium [&_strong]:text-(--ink)"

export const proseComponents: Components = {
  h1: ({ children }) => <h1 className="t-h2 mb-6">{children}</h1>,
  h2: heading(2),
  h3: heading(3),
  p: ({ children }) => <p className={`mb-4 ${text}`}>{children}</p>,
  ul: ({ children }) => <ul className={`mb-4 list-disc space-y-2 pl-5 marker:text-(--ink-3) ${text}`}>{children}</ul>,
  ol: ({ children }) => <ol className={`mb-4 list-decimal space-y-2 pl-5 marker:text-(--ink-3) ${text}`}>{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  a: ({ href, children }) => (
    <a href={href} className="text-(--ink) underline decoration-(--rule-strong) underline-offset-4 hover:decoration-(--ink)">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded-[3px] border border-(--rule) bg-(--white) px-[0.35em] py-[0.1em] font-mono text-[0.875em] text-(--ink)">{children}</code>
  ),
  pre: ({ children }) => {
    const child = Children.only(children) as ReactElement<{ className?: string; children?: ReactNode }>
    const lang = /language-([\w-]+)/.exec(child.props.className ?? "")?.[1] ?? ""
    const code = textOf(child.props.children).replace(/\n$/, "")
    return <CodeBlock lang={lang} code={code} />
  },
  table: ({ children }) => (
    <div className="my-5 overflow-x-auto">
      <table className="w-full border-collapse border-b border-(--rule) text-left">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="pr-4 pb-2.5 text-[0.8125rem] font-normal text-(--ink-3)">{children}</th>,
  td: ({ children }) => (
    <td className="border-t border-(--rule) py-3 pr-4 align-baseline text-[0.9375rem] leading-[1.55] text-(--ink-2) first:whitespace-nowrap first:text-(--ink) [&_strong]:font-medium [&_strong]:text-(--ink)">
      {children}
    </td>
  ),
  blockquote: ({ children }) => <blockquote className="my-5 border-l-2 border-(--brand) pl-4 [&>p]:mb-0">{children}</blockquote>,
}

export function Prose({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} components={proseComponents}>
      {children}
    </Markdown>
  )
}
