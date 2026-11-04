import { ChevronRight } from "lucide-react"
import { Link } from "react-router"
import { GithubMark } from "@/components/brand/github"
import { Shell } from "../studio/shell"

export function PluginsScreen() {
  return <Shell active="Plugins" crumbs={<span>Plugins</span>} contentClassName="overflow-y-auto">
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-10 max-md:px-4">
      <h1 className="text-3xl font-semibold">Plugins</h1>
      <p className="text-sm text-muted-foreground">Connect services to your workspace.</p>
      <Link to="/plugins/github" className="flex items-center gap-4 rounded-lg border border-border bg-card p-5 outline-none hover:bg-raised focus-visible:ring-2 focus-visible:ring-ring">
        <GithubMark className="size-6 shrink-0" />
        <div className="min-w-0 flex-1"><h2 className="font-semibold">GitHub</h2><p className="text-sm text-muted-foreground">Manage your GitHub connection for repositories and pull requests.</p></div>
        <ChevronRight className="size-4 shrink-0" />
      </Link>
    </div>
  </Shell>
}
