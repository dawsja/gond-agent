import { useGithub } from "@/lib/queries"
import { Shell } from "../studio/shell"
import { Section, Row } from "../studio/section"
export function PluginsScreen() {
  const { data, isPending, isError } = useGithub()
  return <Shell active="Plugins" crumbs={<span>Plugins</span>} contentClassName="overflow-y-auto"><div className="mx-auto max-w-[760px] space-y-5 px-5 py-10"><h1 className="text-3xl font-semibold">Connections</h1>
    <Section title="GitHub" description="Repository access comes from the GitHub session configured by your host administrator."><Row label="Status">{isPending ? "Checking…" : isError ? "Couldn't check GitHub" : data?.configured ? `Signed in as ${data.login}` : "Not connected"}</Row></Section>
    {!data?.configured && !isPending && <p className="text-sm text-muted-foreground">Ask your administrator to sign in to GitHub on the host and make that session available to Gond Agent.</p>}
  </div></Shell>
}
