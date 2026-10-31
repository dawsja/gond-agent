import { CLIAgents } from "./cli-agents"
import { MCPAccess } from "./mcp-access"
import { useEffect } from "react"
import { useLocation } from "react-router"
import { useMe } from "@/lib/queries"
import { OIDCSettings } from "./oidc"
import { ProviderSettings } from "./providers"
import { SessionsSection } from "./sessions"
import { ProfilePhoto } from "./profile-photo"
import { DeleteAccount } from "./delete-account"
import { Row, Section } from "../studio/section"
import { Shell } from "../studio/shell"
export function SettingsScreen() {
  const { data: me } = useMe(), { hash } = useLocation()
  useEffect(() => { if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" }) }, [hash])
  return <Shell active="Settings" crumbs={<span>Settings</span>} contentClassName="overflow-y-auto"><div className="mx-auto w-full max-w-[760px] space-y-4 px-8 py-10 max-md:px-4">
    <h1 className="mb-5 text-3xl font-semibold">Settings</h1>
    <Section title="Account" description="Your account on this Gond Agent server."><ProfilePhoto /><Row label="Name">{me?.user?.name ?? "—"}</Row><Row label="Email">{me?.user?.email ?? "—"}</Row></Section>
    <div id="subscription-agents"><CLIAgents /></div>
    {me?.admin && <><div id="providers"><ProviderSettings /></div><div id="oidc"><OIDCSettings /></div></>}
    <div id="sessions"><SessionsSection /></div>
    <div id="mcp"><MCPAccess /></div>
    <div id="delete"><DeleteAccount /></div>
  </div></Shell>
}
