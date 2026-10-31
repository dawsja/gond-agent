import { CLIAgents } from "./cli-agents"
import { MCPAccess } from "./mcp-access"
import { useEffect, type ReactNode } from "react"
import { useLocation } from "react-router"
import { useMe } from "@/lib/queries"
import { OIDCSettings } from "./oidc"
import { ProviderSettings } from "./providers"
import { SessionsSection } from "./sessions"
import { ProfilePhoto } from "./profile-photo"
import { DeleteAccount } from "./delete-account"
import { Row, Section, SectionHeadingLevel } from "../studio/section"
import { Shell } from "../studio/shell"

function SettingsCategory({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3" data-settings-category>
    <h2 id={`${id}-heading`} className="text-2xl leading-8 font-semibold tracking-tight text-foreground">{title}</h2>
    <SectionHeadingLevel.Provider value="h3"><div className="flex flex-col gap-4">{children}</div></SectionHeadingLevel.Provider>
  </section>
}

export function SettingsScreen() {
  const { data: me } = useMe(), { hash } = useLocation()
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }) }, [hash])
  return <Shell active="Settings" crumbs={<span>Settings</span>} contentClassName="overflow-y-auto"><div className="mx-auto flex w-full max-w-[760px] flex-col gap-10 px-8 py-10 max-md:gap-8 max-md:px-4">
    <h1 className="text-3xl font-semibold">Settings</h1>
    <SettingsCategory id="personal-settings" title="Personal settings">
      <Section title="Account" description="Your account on this Gond Agent server."><ProfilePhoto /><Row label="Name">{me?.user?.name ?? "—"}</Row><Row label="Email">{me?.user?.email ?? "—"}</Row></Section>
    </SettingsCategory>
    <SettingsCategory id="model-settings" title="Models">
      <div id="subscription-agents"><CLIAgents /></div>
      {me?.admin && <div id="providers"><ProviderSettings /></div>}
    </SettingsCategory>
    <SettingsCategory id="security-settings" title="Security">
      {me?.admin && <div id="oidc"><OIDCSettings /></div>}
      <div id="sessions"><SessionsSection /></div>
    </SettingsCategory>
    <SettingsCategory id="agent-access-settings" title="Agent access">
      <div id="mcp"><MCPAccess /></div>
    </SettingsCategory>
    <SettingsCategory id="account-management-settings" title="Account management">
      <div id="delete"><DeleteAccount /></div>
    </SettingsCategory>
  </div></Shell>
}
