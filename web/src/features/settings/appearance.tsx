import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Moon, Sun, SunMoon, X } from "lucide-react"
import { Toast } from "radix-ui"
import { ACCENTS, ACCENT_LABELS, DEFAULT_ACCENT, isAccent, type Accent } from "@shared/accents"
import { DEFAULT_THEME, isTheme, THEMES, type Theme } from "@shared/theme-preference"
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@shared/menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shared/ui/select"
import { Button } from "@shared/ui/button"
import { api, type Me } from "@/lib/api"
import { applyAccent } from "@/lib/accent"
import { useMe } from "@/lib/queries"
import { setTheme } from "@/lib/theme"
import { Row, Section } from "../studio/section"

const OPTIONS = {
  system: { label: "System", Icon: SunMoon },
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
} as const

function Swatch({ accent }: { accent: Accent }) {
  return <span aria-hidden="true" data-accent={accent} className="size-3 shrink-0 rounded-full bg-[var(--tint)]" />
}

export function Appearance() {
  const { data: me } = useMe(), qc = useQueryClient()
  const [themeError, setThemeError] = useState(false), [colorError, setColorError] = useState(false)
  const accent = me?.accent ?? DEFAULT_ACCENT
  const saveTheme = useMutation({
    mutationFn: (theme: Theme) => api("/v1/me/theme", { method: "PUT", body: { theme } }),
    onMutate: async theme => {
      await qc.cancelQueries({ queryKey: ["me"] })
      const before = qc.getQueryData<Me>(["me"])?.theme ?? DEFAULT_THEME
      setThemeError(false)
      setTheme(theme)
      qc.setQueryData<Me>(["me"], old => old ? { ...old, theme } : old)
      return before
    },
    onError: (_error, _theme, before = DEFAULT_THEME) => {
      qc.setQueryData<Me>(["me"], current => current && { ...current, theme: before })
      setTheme(before)
      setThemeError(true)
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["me"] }) },
  })
  const saveAccent = useMutation({
    mutationFn: (next: Accent) => api<{ accent: Accent }>("/v1/me/accent", { method: "PUT", body: { accent: next } }),
    onMutate: async next => {
      await qc.cancelQueries({ queryKey: ["me"] })
      const previous = qc.getQueryData<Me>(["me"])?.accent ?? DEFAULT_ACCENT
      setColorError(false)
      qc.setQueryData<Me>(["me"], current => current && { ...current, accent: next })
      applyAccent(next)
      return previous
    },
    onSuccess: result => {
      qc.setQueryData<Me>(["me"], current => current && { ...current, accent: result.accent })
      applyAccent(result.accent)
    },
    onError: (_error, _next, previous = DEFAULT_ACCENT) => {
      qc.setQueryData<Me>(["me"], current => current && { ...current, accent: previous })
      applyAccent(previous)
      setColorError(true)
    },
  })
  const busy = !me || saveTheme.isPending || saveAccent.isPending
  return <Section title="Appearance" description="Your theme and color follow you to every device.">
    <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-3 max-md:px-4">
      <div className="min-w-0"><label id="theme-label" className="text-sm font-medium">Theme</label><p className="mt-1 text-xs text-muted-foreground">Follow your device, or pick one.</p></div>
      <Select value={me?.theme ?? DEFAULT_THEME} disabled={busy} onValueChange={value => { if (isTheme(value) && value !== me?.theme) saveTheme.mutate(value) }}>
        <SelectTrigger aria-labelledby="theme-label" className="w-36 shrink-0"><SelectValue /></SelectTrigger>
        <SelectContent>{THEMES.map(theme => { const { Icon, label } = OPTIONS[theme]; return <SelectItem key={theme} value={theme}><Icon />{label}</SelectItem> })}</SelectContent>
      </Select>
    </div>
    <Row label="Color"><Menu>
      <MenuTrigger asChild><button type="button" aria-label="Color" disabled={busy} className="flex h-8 items-center gap-2 rounded-[4px] border border-border-strong bg-transparent px-2.5 text-[13px] hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">
        <Swatch accent={accent} />{ACCENT_LABELS[accent]}<ChevronDown className="size-3.5 text-muted-foreground" />
      </button></MenuTrigger>
      <MenuContent align="end"><MenuRadioGroup value={accent} onValueChange={value => { if (isAccent(value) && value !== accent) saveAccent.mutate(value) }}>
        {ACCENTS.map(value => <MenuRadioItem key={value} value={value}><span className="flex items-center gap-2"><Swatch accent={value} />{ACCENT_LABELS[value]}</span></MenuRadioItem>)}
      </MenuRadioGroup></MenuContent>
    </Menu></Row>
    {themeError && <div role="alert" className="fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-32px)] items-center gap-3 rounded-md border border-border-strong bg-popover p-4 text-sm text-bad shadow-subtle-3">Couldn't change the theme. Try again.<Button variant="ghost" size="icon" aria-label="Dismiss theme error" onClick={() => setThemeError(false)}><X /></Button></div>}
    <Toast.Provider><Toast.Root open={colorError} onOpenChange={setColorError} duration={6000} className="flex items-center gap-3 rounded-md border border-border-strong bg-popover p-4 text-sm text-foreground shadow-lg">
      <Toast.Description>Couldn't save your color. Try again.</Toast.Description>
      <Toast.Close aria-label="Dismiss error" className="rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-ring"><X className="size-4" /></Toast.Close>
    </Toast.Root><Toast.Viewport className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-32px)] outline-none" /></Toast.Provider>
  </Section>
}
