import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, X } from "lucide-react"
import { Toast } from "radix-ui"
import { ACCENTS, ACCENT_LABELS, DEFAULT_ACCENT, isAccent, type Accent } from "@shared/accents"
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "@shared/menu"
import { api, type Me } from "@/lib/api"
import { applyAccent } from "@/lib/accent"
import { useMe } from "@/lib/queries"
import { Row, Section } from "../studio/section"

function Swatch({ accent }: { accent: Accent }) {
  return <span aria-hidden="true" data-accent={accent} className="size-3 shrink-0 rounded-full bg-[var(--tint)]" />
}

export function Appearance() {
  const { data: me } = useMe(), qc = useQueryClient()
  const [error, setError] = useState(false)
  const accent = me?.accent ?? DEFAULT_ACCENT
  const save = useMutation({
    mutationFn: (next: Accent) => api<{ accent: Accent }>("/v1/me/accent", { method: "PUT", body: { accent: next } }),
    onMutate: async next => {
      await qc.cancelQueries({ queryKey: ["me"] })
      const previous = qc.getQueryData<Me>(["me"])
      setError(false)
      qc.setQueryData<Me>(["me"], current => current && { ...current, accent: next })
      applyAccent(next)
      return previous
    },
    onSuccess: result => {
      qc.setQueryData<Me>(["me"], current => current && { ...current, accent: result.accent })
      applyAccent(result.accent)
    },
    onError: (_error, _next, previous) => {
      if (previous) qc.setQueryData(["me"], previous)
      applyAccent(previous?.accent ?? DEFAULT_ACCENT)
      setError(true)
    },
  })
  return <Section title="Appearance" description="Choose the accent color for your workspace.">
    <Row label="Color"><Menu>
      <MenuTrigger asChild><button type="button" aria-label="Color" disabled={!me || save.isPending} className="flex h-8 items-center gap-2 rounded-[4px] border border-border-strong bg-transparent px-2.5 text-[13px] hover:bg-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">
        <Swatch accent={accent} />{ACCENT_LABELS[accent]}<ChevronDown className="size-3.5 text-muted-foreground" />
      </button></MenuTrigger>
      <MenuContent align="end"><MenuRadioGroup value={accent} onValueChange={value => { if (isAccent(value) && value !== accent) save.mutate(value) }}>
        {ACCENTS.map(value => <MenuRadioItem key={value} value={value}><span className="flex items-center gap-2"><Swatch accent={value} />{ACCENT_LABELS[value]}</span></MenuRadioItem>)}
      </MenuRadioGroup></MenuContent>
    </Menu></Row>
    <Toast.Provider><Toast.Root open={error} onOpenChange={setError} duration={6000} className="flex items-center gap-3 rounded-md border border-border-strong bg-popover p-4 text-sm text-foreground shadow-lg">
      <Toast.Description>Couldn't save your color. Try again.</Toast.Description>
      <Toast.Close aria-label="Dismiss error" className="rounded-sm p-1 focus-visible:outline-2 focus-visible:outline-ring"><X className="size-4" /></Toast.Close>
    </Toast.Root><Toast.Viewport className="fixed right-4 bottom-4 z-50 w-80 max-w-[calc(100vw-32px)] outline-none" /></Toast.Provider>
  </Section>
}
