import { People, SignInMethods } from "./accounts"
import { WebSearchSettings } from "./web-search"
import { ChatGPTPlanSettings } from "./chatgpt-plan"
import { MCPAccess } from "./mcp-access"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useNavigationType } from "react-router"
import { useMe } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shared/ui/select"
import { OIDCSettings } from "./oidc"
import { ProviderSettings } from "./providers"
import { SessionsSection } from "./sessions"
import { ProfilePhoto } from "./profile-photo"
import { DeleteAccount } from "./delete-account"
import { Appearance } from "./appearance"
import { settingsPages, type SettingsPage, type SettingsSectionId } from "./registry"
import { Row, Section, SectionHeadingLevel } from "../studio/section"
import { Shell } from "../studio/shell"

// Exhaustive renderer: adding a registry section requires choosing its existing UI here.
const SECTIONS: Record<SettingsSectionId, () => ReactNode> = {
  account: Account,
  appearance: Appearance,
  chatgpt: () => <ChatGPTPlanSettings />,
  providers: () => <ProviderSettings />,
  "sign-in-methods": SignInMethods,
  oidc: OIDCSettings,
  sessions: SessionsSection,
  people: People,
  "web-search": WebSearchSettings,
  mcp: MCPAccess,
  delete: DeleteAccount,
}

function Account() {
  const { data: me } = useMe()
  return <Section title="Account" description="Your account on this Gond Agent server."><ProfilePhoto /><Row label="Name">{me?.user?.name ?? "—"}</Row><Row label="Email">{me?.user?.email ?? "—"}</Row></Section>
}

function SettingsPanel({ page, active, admin }: { page: SettingsPage; active: boolean; admin: boolean }) {
  const { hash, key } = useLocation(), navigationType = useNavigationType()
  const panel = useRef<HTMLDivElement>(null)
  const anchoredEntries = useRef(new Set<string>())
  useLayoutEffect(() => {
    if (!active || !hash || (navigationType === "POP" && anchoredEntries.current.has(key))) return
    const scroller = panel.current, target = document.getElementById(hash.slice(1))
    if (!scroller || !target || !scroller.contains(target)) return
    // Defer marking until paint so StrictMode's setup/cleanup replay can attach
    // the layout observer again rather than mistaking it for history navigation.
    const markEntry = requestAnimationFrame(() => anchoredEntries.current.add(key))
    const align = () => { scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24 }
    align()
    target.focus({ preventScroll: true })
    // Async forms above an anchor can grow after the first paint. Track their
    // layout until the person interacts; never fight their own scrolling.
    const observer = new ResizeObserver(align)
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild)
    const stop = () => observer.disconnect()
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const
    for (const event of events) scroller.addEventListener(event, stop, { passive: true })
    return () => {
      cancelAnimationFrame(markEntry)
      observer.disconnect()
      for (const event of events) scroller.removeEventListener(event, stop)
    }
  }, [active, hash, key, navigationType])
  return <div ref={panel} hidden={!active} inert={!active} data-settings-page={page.id} className="h-full overflow-y-auto overscroll-contain px-8 py-8 max-md:px-4 max-md:py-6">
    <section aria-labelledby={`${page.id}-heading`} className="mx-auto flex w-full max-w-[760px] flex-col gap-5" data-settings-category>
      <h2 id={`${page.id}-heading`} className="text-2xl leading-8 font-semibold tracking-tight text-foreground">{page.title}</h2>
      <SectionHeadingLevel.Provider value="h3"><div className="flex flex-col gap-4">
        {page.sections.filter(section => admin || !section.adminOnly).map(section => {
          const Component = SECTIONS[section.id]
          return <div key={section.id} id={section.id} tabIndex={-1} className="outline-none"><Component /></div>
        })}
      </div></SectionHeadingLevel.Provider>
    </section>
  </div>
}

export function SettingsScreen({ page }: { page: SettingsPage }) {
  useLayoutEffect(() => {
    // Each retained panel owns its scroll offset; native hash restoration would
    // overwrite it on Back, including navigation interrupted before React paints.
    const previous = history.scrollRestoration
    history.scrollRestoration = "manual"
    return () => { history.scrollRestoration = previous }
  }, [])
  const { data: me } = useMe(), navigate = useNavigate()
  const pages = settingsPages(!!me?.admin)
  // Retain visited panels (not copies of drafts). Existing forms, expanded details,
  // pending saves and each panel's scroll offset survive topic navigation. Nothing
  // is persisted to browser storage, especially provider keys or OIDC secrets.
  const [visited, setVisited] = useState([page.id])
  if (!visited.includes(page.id)) setVisited([...visited, page.id])
  return <Shell active="Settings" crumbs={<><span>Settings</span><span aria-hidden="true" className="text-muted-foreground">/</span><span>{page.title}</span></>}>
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-8 py-5 max-md:px-4"><h1 className="text-3xl font-semibold">Settings</h1></div>
      <div className="min-h-0 flex-1 md:grid md:grid-cols-[192px_minmax(0,1fr)]">
        <nav aria-label="Settings pages" className="hidden flex-col gap-1 overflow-y-auto border-r border-border p-3 md:flex" onKeyDown={event => {
          const links = Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>("a"))
          const index = links.indexOf(document.activeElement as HTMLAnchorElement)
          if (index < 0 || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return
          event.preventDefault()
          const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : (index + (event.key === "ArrowDown" ? 1 : links.length - 1)) % links.length
          links[next]?.focus()
        }}>
          {pages.map(item => <Link key={item.id} to={item.route} aria-current={item.id === page.id ? "page" : undefined} className={cn("flex min-h-9 items-center gap-2 rounded-[4px] px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", item.id === page.id ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-raised hover:text-foreground")}><item.icon aria-hidden="true" className="size-4 shrink-0" />{item.title}</Link>)}
        </nav>
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div className="shrink-0 border-b border-border px-4 py-3 md:hidden">
            <Select value={page.id} onValueChange={id => { const target = pages.find(item => item.id === id); if (target) navigate(target.route) }}>
              <SelectTrigger aria-label="Settings page" className="w-full rounded-[4px]"><SelectValue /></SelectTrigger>
              <SelectContent className="rounded-[4px]">{pages.map(item => <SelectItem key={item.id} value={item.id}><item.icon aria-hidden="true" />{item.title}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="min-h-0 flex-1">{pages.filter(item => visited.includes(item.id)).map(item => <SettingsPanel key={item.id} page={item} active={page.id === item.id} admin={!!me?.admin} />)}</div>
        </div>
      </div>
    </div>
  </Shell>
}
