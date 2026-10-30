import { Menu } from "lucide-react"
import { useState } from "react"
import { Button } from "@shared/ui/button"
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "@shared/ui/sheet"
import { GondAgentLockup } from "@/components/brand/logo"
import { APP_URL, NAV } from "@/content"
import { scrollToSection } from "@/lib/scroll"

export function Nav() {
  const [open, setOpen] = useState(false)
  return <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm"><nav aria-label="Primary" className="mx-auto flex h-16 max-w-[90rem] items-center gap-8 px-4 sm:px-8 lg:px-12">
    <a href="/" aria-label="Gond Agent home"><GondAgentLockup height={26} /></a>
    <div className="hidden items-center gap-1 md:flex">{NAV.map(item => <Button key={item.id} variant="ghost" onClick={() => scrollToSection(item.id)}>{item.label}</Button>)}<Button asChild variant="ghost"><a href="/docs">Docs</a></Button></div>
    <div className="ml-auto flex items-center gap-2"><Button asChild variant="ghost" className="max-sm:hidden"><a href={APP_URL}>Sign in</a></Button><Button asChild className="max-sm:hidden"><a href={APP_URL}>Open workspace</a></Button>
      <Sheet open={open} onOpenChange={setOpen}><SheetTrigger asChild><Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu"><Menu /></Button></SheetTrigger><SheetContent><SheetTitle className="pt-3 text-lg font-semibold">Gond Agent</SheetTitle><SheetDescription className="text-sm text-muted-foreground">Self-hosted coding agents.</SheetDescription><div className="mt-8 flex flex-col gap-2">{NAV.map(item => <SheetClose key={item.id} asChild><Button variant="ghost" className="justify-start" onClick={() => scrollToSection(item.id)}>{item.label}</Button></SheetClose>)}<Button asChild variant="ghost" className="justify-start"><a href="/docs">Documentation</a></Button><Button asChild><a href={APP_URL}>Open workspace</a></Button></div></SheetContent></Sheet>
    </div>
  </nav></header>
}
