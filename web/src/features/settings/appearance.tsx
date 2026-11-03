import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Moon, Sun, SunMoon, X } from "lucide-react"
import { DEFAULT_THEME, isTheme, THEMES, type Theme } from "@shared/theme-preference"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@shared/ui/select"
import { Button } from "@shared/ui/button"
import { api, type Me } from "@/lib/api"
import { useMe } from "@/lib/queries"
import { setTheme } from "@/lib/theme"
import { Section } from "../studio/section"

const OPTIONS = {
  system: { label: "System", Icon: SunMoon },
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
} as const

export function Appearance() {
  const { data: me } = useMe(), qc = useQueryClient()
  const [error, setError] = useState(false)
  const save = useMutation({
    mutationFn: (theme: Theme) => api("/v1/me/theme", { method: "PUT", body: { theme } }),
    onMutate: async theme => {
      await qc.cancelQueries({ queryKey: ["me"] })
      const before = qc.getQueryData<Me>(["me"])
      setError(false)
      setTheme(theme)
      qc.setQueryData<Me>(["me"], old => old ? { ...old, theme } : old)
      return before
    },
    onError: (_error, _theme, before) => {
      if (before) qc.setQueryData(["me"], before)
      setTheme(before?.theme ?? DEFAULT_THEME)
      setError(true)
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["me"] }) },
  })
  return <Section title="Appearance" description="Your theme follows you to every device.">
    <div className="flex items-center justify-between gap-4 border-t border-border px-5 py-3 max-md:px-4">
      <div className="min-w-0"><label id="theme-label" className="text-sm font-medium">Theme</label><p className="mt-1 text-xs text-muted-foreground">Follow your device, or pick one.</p></div>
      <Select value={me?.theme ?? DEFAULT_THEME} disabled={!me || save.isPending} onValueChange={value => { if (isTheme(value) && value !== me?.theme) save.mutate(value) }}>
        <SelectTrigger aria-labelledby="theme-label" className="w-36 shrink-0"><SelectValue /></SelectTrigger>
        <SelectContent>{THEMES.map(theme => { const { Icon, label } = OPTIONS[theme]; return <SelectItem key={theme} value={theme}><Icon />{label}</SelectItem> })}</SelectContent>
      </Select>
    </div>
    {error && <div role="alert" className="fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-32px)] items-center gap-3 rounded-md border border-border-strong bg-popover p-4 text-sm text-bad shadow-subtle-3">Couldn't change the theme. Try again.<Button variant="ghost" size="icon" aria-label="Dismiss theme error" onClick={() => setError(false)}><X /></Button></div>}
  </Section>
}
