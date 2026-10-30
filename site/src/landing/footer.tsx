import { Button } from "@shared/ui/button"
import { GondAgentLockup } from "@/components/brand/logo"
import { FOOTER } from "@/content"

export function Footer() {
  return <footer className="border-t border-border bg-sidebar"><div className="mx-auto flex max-w-[90rem] flex-wrap items-start justify-between gap-8 px-4 py-10 sm:px-8 lg:px-12">
    <div className="flex max-w-sm flex-col gap-4"><GondAgentLockup height={24} /><p className="text-sm leading-6 text-muted-foreground">{FOOTER.note}</p><a className="text-sm text-muted-foreground hover:text-foreground" href={`mailto:${FOOTER.email}`}>{FOOTER.email}</a></div>
    <div className="flex flex-col gap-4"><nav aria-label="Footer" className="flex flex-wrap gap-2">{FOOTER.links.map(link => <Button key={link.href} asChild variant="ghost"><a href={link.href}>{link.label}</a></Button>)}</nav><p className="text-sm text-muted-foreground">© {new Date().getFullYear()} Concho Systems LLC</p></div>
  </div></footer>
}
