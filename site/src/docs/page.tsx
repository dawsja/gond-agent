// Instance docs: one page per topic in the landing page's look. A topic list on the left, the page in
// the middle, "On this page" on the right; on phones a topic picker sits under the header.
import { ChevronDown } from "lucide-react"
import { useEffect, useState } from "react"
import { GondAgentLockup } from "@/components/brand/logo"
import { APP_URL, NAV } from "@/content"
import { Prose, slug } from "@/lib/prose"
import { cn } from "@/lib/utils"
import "../landing/c.css"
import { Footer } from "../landing/footer"
import { GROUPS, sectionsOf, topicFor, type Topic } from "./topics"

const wrap = "mx-auto w-full max-w-[90rem] px-4 sm:px-8 lg:px-12"
const href = (t: Topic) => `/docs/${t.slug}`

function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-(--rule) bg-(--paper)">
      <nav aria-label="Primary" className={cn(wrap, "flex h-16 items-center justify-between gap-6")}>
        <div className="flex min-w-0 items-center gap-10">
          <a href="/" className="flex shrink-0 items-center gap-2.5 rounded-[2px] text-(--ink)">
            <GondAgentLockup height={26} />
          </a>
          <div className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <a key={item.id} href={`/#${item.id}`} className="flex h-10 items-center rounded-[2px] px-3 text-[0.9375rem] text-(--ink-2) transition-colors hover:text-(--ink)">
                {item.label}
              </a>
            ))}
            <a href="/docs" aria-current="page" className="flex h-10 items-center rounded-[2px] px-3 text-[0.9375rem] text-(--ink)">
              Docs
            </a>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a href={APP_URL} className="hidden h-10 items-center rounded-[2px] px-3 text-[0.9375rem] text-(--ink-2) transition-colors hover:text-(--ink) sm:flex">
            Sign in
          </a>
          <a href={APP_URL} className="flex h-10 items-center rounded-[3px] bg-(--ink) px-4 text-[0.9375rem] font-medium text-(--paper) transition-colors hover:bg-(--ink-hover)">
            Get started
          </a>
        </div>
      </nav>
    </header>
  )
}

function TopicList({ current, className, id }: { current: Topic; className?: string; id?: string }) {
  return (
    <nav id={id} aria-label="Docs" className={className}>
      {GROUPS.map((g) => (
        <div key={g.label} className="mb-7 last:mb-0">
          <h2 className="mb-2 text-[0.8125rem] text-(--ink-3)">{g.label}</h2>
          <ul>
            {g.topics.map((t) => {
              const on = t.slug === current.slug
              return (
                <li key={t.slug}>
                  <a
                    href={href(t)}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "flex h-[2.125rem] items-center gap-2.5 rounded-[2px] text-[0.9375rem] transition-colors",
                      on ? "font-medium text-(--ink)" : "text-(--ink-2) hover:text-(--ink)",
                    )}
                  >
                    <span aria-hidden className={cn("size-2 shrink-0", on && "bg-(--brand)")} />
                    {t.title}
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

/** Phones: "Docs / Introduction" under the header; tap to pick another topic. */
function TopicPicker({ current }: { current: Topic }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="sticky top-16 z-40 border-b border-(--rule) bg-(--paper) lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="docs-topics"
        className={cn(wrap, "flex h-12 items-center justify-between text-[0.9375rem]")}
      >
        <span>
          <span className="text-(--ink-3)">Docs / </span>
          {current.title}
        </span>
        <ChevronDown aria-hidden className={cn("size-4 text-(--ink-2) transition-transform", open && "rotate-180")} />
      </button>
      {open && <TopicList id="docs-topics" current={current} className={cn(wrap, "max-h-[70vh] overflow-y-auto border-t border-(--rule) pt-5 pb-6")} />}
    </div>
  )
}

/** "On this page", with the section in view highlighted. */
function OnThisPage({ sections }: { sections: string[] }) {
  const [active, setActive] = useState(sections[0] ? slug(sections[0]) : "")
  useEffect(() => {
    const ids = sections.map(slug)
    const onScroll = () => {
      // The last heading above the top quarter of the window is the one being read.
      let current = ids[0] ?? ""
      for (const id of ids) {
        const el = document.getElementById(id)
        if (el && el.getBoundingClientRect().top < window.innerHeight * 0.25) current = id
      }
      setActive(current)
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [sections])
  if (sections.length < 2) return null
  return (
    <nav aria-label="On this page" className="border-l border-(--rule) pl-5">
      <h2 className="mb-2 text-[0.8125rem] text-(--ink-3)">On this page</h2>
      <ul>
        {sections.map((s) => (
          <li key={s}>
            <a
              href={`#${slug(s)}`}
              className={cn("block py-[0.3125rem] text-[0.875rem] transition-colors", active === slug(s) ? "text-(--ink)" : "text-(--ink-2) hover:text-(--ink)")}
            >
              {s}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function PrevNext({ current }: { current: Topic }) {
  const all = GROUPS.flatMap((g) => g.topics)
  const i = all.findIndex((t) => t.slug === current.slug)
  const prev = all[i - 1]
  const next = all[i + 1]
  return (
    <div className="mt-16 grid grid-cols-2 gap-4 border-t border-(--rule) pt-6">
      <div>
        {prev && (
          <a href={href(prev)} className="group block">
            <span className="block text-[0.8125rem] text-(--ink-3)">Previous</span>
            <span className="text-[1.0625rem] text-(--ink) underline-offset-4 group-hover:underline">{prev.title}</span>
          </a>
        )}
      </div>
      <div className="text-right">
        {next && (
          <a href={href(next)} className="group block">
            <span className="block text-[0.8125rem] text-(--ink-3)">Next</span>
            <span className="text-[1.0625rem] text-(--ink) underline-offset-4 group-hover:underline">{next.title}</span>
          </a>
        )}
      </div>
    </div>
  )
}

export default function Docs({ path }: { path: string }) {
  const topic = topicFor(path)
  const sections = sectionsOf(topic.body)
  useEffect(() => {
    document.title = `${topic.title} · Gond Agent Docs`
  }, [topic])
  return (
    <div className="mc min-h-screen overflow-x-clip">
      <Header />
      <TopicPicker current={topic} />
      <div className={cn(wrap, "grid grid-cols-1 gap-x-16 pt-8 pb-24 sm:pt-12 lg:grid-cols-[13.5rem_minmax(0,44rem)_1fr] xl:gap-x-20")}>
        <aside className="hidden lg:block">
          <TopicList current={topic} className="sticky top-28" />
        </aside>
        <main className="min-w-0">
          <h1 className="text-[2.75rem] leading-none font-semibold tracking-[-0.045em] sm:text-[3.5rem]">{topic.title}</h1>
          <p className="t-lead mt-4 text-(--ink-2)">{topic.lead}</p>
          <div className="mt-2">
            <Prose>{topic.body}</Prose>
          </div>
          <PrevNext current={topic} />
        </main>
        <aside className="hidden xl:block">
          <div className="sticky top-28 max-w-[13rem]">
            <OnThisPage sections={sections} />
          </div>
        </aside>
      </div>
      <Footer />
    </div>
  )
}
