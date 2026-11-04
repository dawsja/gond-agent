import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router"
import { Switch } from "@shared/ui/switch"
import { SettingsRoute } from "@/app/settings-route"
import { AutomationsScreen } from "@/features/automations/automations-screen"
import "@/index.css"

function SwitchFixture() {
  const [checked, setChecked] = useState(false)
  const [pending, setPending] = useState(false)
  const [submits, setSubmits] = useState(0)
  return <form className="space-y-5 p-5" onSubmit={e => { e.preventDefault(); setSubmits(submits + 1) }}>
    <button type="button">Before</button>
    <div className="flex items-center gap-4"><label htmlFor="example">Example setting</label><Switch id="example" checked={checked} onCheckedChange={setChecked} pending={pending} /></div>
    <Switch aria-label="Disabled setting" checked={false} disabled onCheckedChange={() => { throw new Error("Disabled switch toggled") }} />
    <button type="button" onClick={() => setPending(!pending)}>Simulate pending</button>
    <button type="button">After</button>
    <output aria-label="Form submissions">{submits}</output>
  </form>
}

const query = new URLSearchParams(location.search)
document.documentElement.classList.toggle("dark", query.get("theme") === "dark")
document.documentElement.dataset.accent = query.get("accent") ?? "blue"
const view = query.get("view")
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[view === "automations" ? "/automations" : "/settings/sign-in-people"]}>{view === "component" ? <SwitchFixture /> : view === "automations" ? <AutomationsScreen /> : <SettingsRoute />}</MemoryRouter></QueryClientProvider>)
