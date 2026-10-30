import { BarChart3, BookOpen, House, LogOut, PanelLeft, Plug, Plus, Search, Settings2, Workflow } from "lucide-react"
import { type ReactNode, useState } from "react"
import { NavLink, useNavigate } from "react-router"
import { Button } from "@shared/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@shared/ui/sheet"
import { Separator } from "@shared/ui/separator"
import { GondAgentMark } from "@/components/brand/logo"
import { useSession } from "@/app/auth"
import { useMe, useRuns } from "@/lib/queries"
import { initials } from "@/lib/format"
import { DOCS_URL } from "@/lib/links"
import { cn } from "@/lib/utils"
import { prefs } from "@/lib/prefs"
import { Dot } from "./parts"
import { SearchDialog } from "./search-dialog"

const NAV = [
  { label: "Home", icon: House, to: "/" },
  { label: "Usage", icon: BarChart3, to: "/usage" },
  { label: "Plugins", icon: Plug, to: "/plugins" },
  { label: "Automations", icon: Workflow, to: "/automations" },
  { label: "Settings", icon: Settings2, to: "/settings" },
]

export function Shell({ active, activeRun, crumbs, actions, children, contentClassName }: {
  active: string; activeRun?: string; crumbs: ReactNode; actions?: ReactNode; children: ReactNode; contentClassName?: string
}) {
  const [collapsed, setCollapsed] = useState(() => prefs.get("sidebar") === "collapsed")
  const [mobile, setMobile] = useState(false), [searching, setSearching] = useState(false)
  const { data: runs } = useRuns(), { data: me } = useMe(), session = useSession(), navigate = useNavigate()
  const toggle = () => { prefs.set("sidebar", collapsed ? "open" : "collapsed"); setCollapsed(!collapsed) }
  const go = (path: string) => { setMobile(false); navigate(path) }
  const navigation = (compact: boolean) => <>
    <div className={cn("flex items-center gap-3 py-3", compact ? "justify-center" : "px-2")}>
      <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border bg-card"><GondAgentMark size={21} /></span>
      {!compact && <div className="min-w-0"><span className="block text-sm font-semibold">Gond Agent</span><span className="text-xs text-muted-foreground">Self-hosted</span></div>}
      {!compact && <Button size="icon" variant="ghost" className="ml-auto max-md:hidden" onClick={toggle} aria-label="Collapse sidebar"><PanelLeft /></Button>}
    </div>
    {compact && <Button size="icon" variant="ghost" onClick={toggle} aria-label="Expand sidebar" title="Expand sidebar"><PanelLeft /></Button>}
    <Button variant="outline" size={compact ? "icon" : "default"} onClick={() => go("/")} aria-label="New agent" title="New agent"><Plus data-icon="inline-start" />{!compact && "New agent"}</Button>
    <Button variant="ghost" size={compact ? "icon" : "default"} className={cn(!compact && "justify-start")} onClick={() => { setMobile(false); setSearching(true) }} aria-label="Search" title="Search"><Search data-icon="inline-start" />{!compact && "Search"}</Button>
    <Separator />
    <nav aria-label="Workspace" className="flex flex-col gap-1">{NAV.map(({ label, icon: Icon, to }) => <Button key={to} asChild variant="ghost" size={compact ? "icon" : "default"} className={cn(!compact && "justify-start", active === label && "bg-raised text-foreground")}><NavLink to={to} end={to === "/"} onClick={() => setMobile(false)} title={label} aria-label={label}><Icon data-icon="inline-start" />{!compact && label}</NavLink></Button>)}</nav>
    {!compact && <div className="min-h-0 flex-1 overflow-y-auto py-3"><p className="mb-2 px-3 text-xs text-muted-foreground">Recent runs</p><div className="flex flex-col gap-1">{(runs ?? []).slice(0, 12).map(run => <Button key={run.id} variant="ghost" className={cn("justify-start", activeRun === run.id && "bg-raised text-foreground")} onClick={() => go(`/runs/${run.id}`)}><Dot status={run.status} size={6} /><span className="truncate">{run.title}</span></Button>)}{!runs?.length && <p className="px-3 text-xs text-muted-foreground">No runs yet</p>}</div></div>}
    <div className="mt-auto flex flex-col gap-2 pt-3"><Button asChild variant="ghost" size={compact ? "icon" : "default"} className={cn(!compact && "justify-start")}><a href={DOCS_URL} title="Documentation"><BookOpen data-icon="inline-start" />{!compact && "Documentation"}</a></Button><Separator />
      <div className={cn("flex items-center gap-2 py-2", compact && "justify-center")}><span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card text-xs">{initials(me?.user?.name, me?.user?.email)}</span>{!compact && <div className="min-w-0 flex-1"><span className="block truncate text-sm">{me?.user?.name}</span><span className="block truncate text-xs text-muted-foreground">{me?.user?.email}</span></div>}</div>
      <Button variant="ghost" size={compact ? "icon" : "default"} className={cn(!compact && "justify-start")} onClick={() => void session.signOut()} title="Sign out" aria-label="Sign out"><LogOut data-icon="inline-start" />{!compact && "Sign out"}</Button>
    </div>
  </>
  return <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
    <aside aria-label="Gond Agent navigation" className={cn("hidden shrink-0 flex-col gap-2 border-r border-border bg-sidebar p-3 md:flex", collapsed ? "w-[68px] items-center px-2" : "w-[264px]")}>{navigation(collapsed)}</aside>
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden"><header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5 max-md:px-3">
      <Sheet open={mobile} onOpenChange={setMobile}><SheetTrigger asChild><Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation"><PanelLeft /></Button></SheetTrigger><SheetContent><SheetTitle className="sr-only">Workspace navigation</SheetTitle><SheetDescription className="sr-only">Pages, recent runs and your account.</SheetDescription><div className="flex min-h-0 flex-1 flex-col gap-2 pt-5">{navigation(false)}</div></SheetContent></Sheet>
      <div className="flex min-w-0 items-center gap-2 text-sm">{crumbs}</div><div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
    </header><div className={cn("min-h-0 flex-1", contentClassName)}>{children}</div></main>
    <SearchDialog open={searching} onOpenChange={setSearching} pages={NAV} runs={runs ?? []} />
  </div>
}
