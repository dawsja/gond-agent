// The agent's prose: markdown in the transcript type scale (the web app's run page).
import type { ReactNode } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { mono } from "./theme"
import { cn } from "./utils"

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[4px] border border-border bg-raised px-1 py-px text-[12px] text-foreground" style={mono}>
      {children}
    </code>
  )
}

/** `small`: secondary text (13px, muted). `className` sets the width and base size where the apps differ. */
export function Prose({ text, small, className }: { text: string; small?: boolean; className?: string }) {
  return (
    <div className={cn("space-y-3 leading-[1.65] text-foreground", small && "text-[13px] text-muted-foreground", className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: ({ className, children }) =>
            className ? (
              <code className="block overflow-x-auto rounded-[4px] border border-border bg-card p-3 text-[12px] leading-[20px]" style={mono}>
                {children}
              </code>
            ) : (
              <Code>{children}</Code>
            ),
          pre: ({ children }) => <pre className="whitespace-pre">{children}</pre>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 marker:text-subtle">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5 marker:text-subtle">{children}</ol>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-link underline-offset-2 hover:underline">
              {children}
            </a>
          ),
          h1: ({ children }) => <p className="font-semibold">{children}</p>,
          h2: ({ children }) => <p className="font-semibold">{children}</p>,
          h3: ({ children }) => <p className="font-semibold">{children}</p>,
          strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
          table: ({ children }) => <table className="w-full border-collapse text-[12.5px]">{children}</table>,
          th: ({ children }) => <th className="border border-border px-2 py-1 text-left font-medium">{children}</th>,
          td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}
