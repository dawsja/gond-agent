import { Check, ChevronDown, ExternalLink, GitBranch, MoreHorizontal, Square, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { useLocation, useNavigate } from "react-router"
import { Tabs, TabsList, TabsTrigger } from "@shared/ui/tabs"
import type { Run } from "@/lib/api"
import { ago, greeting, repoName, runElapsed } from "@/lib/format"
import { useDeleteRun, useMe, useModels, useRuns, useStopRun } from "@/lib/queries"
import { ConfirmDialog } from "../studio/confirm-dialog"
import { devOpen } from "@/lib/dev-open"
import { cn } from "@/lib/utils"
import { HeroComposer } from "../studio/composer"
import { DiffCounts, DiffTile, Dot, ModelMark, PrChip, shortModel, StatusPill } from "../studio/parts"
import { Shell } from "../studio/shell"
import { T, mono, tabs } from "../studio/theme"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@shared/menu"

const Sep = () => <span className="text-subtle">·</span>

const SUGGESTIONS = ["Fix the failing CI on main", "Add tests for the untested modules", "Upgrade dependencies and fix what breaks"]

function RunMenu({ run, first }: { run: Run; first?: boolean }) {
  const stop = useStopRun()
  const del = useDeleteRun()
  const [confirming, setConfirming] = useState(false)
  const live = run.status === "working" || run.status === "queued"
  return (
    <>
      <ConfirmDialog
        open={confirming}
        title="Delete this run?"
        body="It disappears now and is erased within 30 days. Its worker container is removed. Pull requests on GitHub stay."
        confirmLabel="Delete run"
        busy={del.isPending}
        error={del.error?.message}
        onCancel={() => setConfirming(false)}
        onConfirm={() => del.mutate({ id: run.id, arg: undefined }, { onSuccess: () => setConfirming(false) })}
      />
      <Menu defaultOpen={first && devOpen("run-menu")}>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="Run actions"
            onClick={(e) => e.stopPropagation()}
            className="grid size-8 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-raised hover:text-foreground"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </MenuTrigger>
        <MenuContent align="end" side="bottom" className="w-52" onClick={(e) => e.stopPropagation()}>
          {run.pr_url && (
            <MenuItem onSelect={() => window.open(run.pr_url!, "_blank", "noopener")}>
              <ExternalLink className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">Open pull request</span>
            </MenuItem>
          )}
          {live && (
            <MenuItem onSelect={() => stop.mutate({ id: run.id, arg: undefined })}>
              <Square className="size-3 fill-current" />
              <span className="min-w-0 flex-1 truncate">Stop</span>
            </MenuItem>
          )}
          {(run.pr_url || live) && <MenuSeparator />}
          <MenuItem onSelect={() => setConfirming(true)} className="text-destructive">
            <Trash2 className="size-3.5" />
            <span className="min-w-0 flex-1 truncate">Delete run</span>
          </MenuItem>
        </MenuContent>
      </Menu>
    </>
  )
}

function RunRow({ run, first, modelName }: { run: Run; first?: boolean; modelName?: string }) {
  const navigate = useNavigate()
  const live = run.status === "working" || run.status === "queued"
  const ended = run.status === "failed" || run.status === "stopped"
  const note = live ? (run.step ?? (run.status === "queued" ? "Waiting for a worker" : "Working")) : ended ? (run.error ?? "Stopped") : undefined
  const elapsed = runElapsed(run)
  return (
    <li
      onClick={() => navigate(`/runs/${run.id}`)}
      className={cn(
        "group relative flex cursor-pointer items-center gap-4 px-4 py-3.5 transition-colors hover:bg-raised/40 max-md:items-start max-md:gap-2 max-md:px-3 max-md:py-3",
        !first && "border-t border-border",
      )}
    >
      <div className="max-md:hidden">
        <DiffTile files={run.files} add={run.additions} del={run.deletions} status={run.status} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5 max-md:flex-col max-md:items-start max-md:gap-1.5">
          <span className="truncate text-[14px] font-medium text-foreground max-md:line-clamp-2 max-md:whitespace-normal">{run.title}</span>
          {run.status !== "merged" && <StatusPill status={run.status}>{run.status === "ready" && !run.pr_number ? "Ready" : undefined}</StatusPill>}
        </div>
        <div className="mt-1.5 flex items-center gap-2 text-[13px] text-muted-foreground max-md:flex-wrap max-md:gap-x-2 max-md:gap-y-1 max-md:text-[12px]">
          {note ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="text-subtle" style={mono}>
                └
              </span>
              <span className={cn("truncate", run.status === "failed" ? "text-failed" : live ? "text-foreground" : "")}>{note}</span>
              {live && run.plan_total > 0 && (
                <span className="shrink-0 text-[12px] text-muted-foreground" style={mono}>
                  · plan {run.plan_done}/{run.plan_total}
                </span>
              )}
            </span>
          ) : (
            <>
              <span className="shrink-0 text-foreground">{repoName(run.repo)}</span>
              <span className="max-md:hidden">
                <Sep />
              </span>
              <span className="inline-flex min-w-0 items-center gap-1 max-md:hidden">
                <GitBranch className="size-3 shrink-0" />
                <span className="max-w-[190px] truncate text-[12px]" style={mono}>
                  {run.branch}
                </span>
              </span>
            </>
          )}
          <Sep />
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <ModelMark id={run.model_id} size={14} />
            {shortModel(modelName, run.model_id)}
          </span>
          {!live && (
            <>
              <Sep />
              <span className="shrink-0">{ago(run.created_at)}</span>
            </>
          )}
          {/* Phones: the diff tile and right-hand columns are hidden, so their facts move here. */}
          {run.files > 0 && (
            <span className="inline-flex items-center gap-2 md:hidden">
              <Sep />
              <DiffCounts add={run.additions} del={run.deletions} className="text-[12px]" />
            </span>
          )}
          {run.pr_number && (
            <span className="inline-flex items-center gap-2 md:hidden">
              <Sep />
              <span style={mono}>#{run.pr_number}</span>
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-5 max-md:-mt-1 max-md:-mr-1">
        <div className="w-[112px] max-md:hidden">
          <PrChip status={run.status} number={run.pr_number} files={run.files} />
        </div>
        <div className={cn("w-[64px] text-right text-[13px] tabular-nums max-md:hidden", elapsed === null ? "text-subtle" : "text-muted-foreground")} style={mono}>
          {elapsed ?? "—"}
        </div>
        <RunMenu run={run} first={first} />
      </div>
    </li>
  )
}

type Filter = "all" | "working" | "ready" | "merged"

function matches(r: Run, f: Filter) {
  if (f === "working") return r.status === "working" || r.status === "queued"
  if (f === "all") return true
  return r.status === f
}

export function HomeScreen() {
  const location = useLocation()
  const focus = (location.state as { focus?: number } | null)?.focus
  const { data: me } = useMe()
  const { data: runs, isLoading } = useRuns()
  const { data: models } = useModels()
  const [filter, setFilter] = useState<Filter>("all")
  const [repo, setRepo] = useState<string>("all")
  const [seed, setSeed] = useState<{ text: string; key: number } | undefined>(focus ? { text: "", key: focus } : undefined)

  const all = useMemo(() => runs ?? [], [runs])
  const count = (f: Filter) => all.filter((r) => matches(r, f)).length
  const repos = useMemo(() => [...new Set(all.map((r) => r.repo))].sort(), [all])
  const shown = all.filter((r) => matches(r, filter) && (repo === "all" || r.repo === repo))
  const modelName = (id: string) => models?.find((m) => m.id === id)?.display_name
  const first = (me?.user?.name ?? "").split(" ")[0]

  return (
    <Shell
      active="Home"
      crumbs={<span className="font-medium text-foreground">Home</span>}
      contentClassName="overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-[900px] px-8 pt-12 pb-16 max-md:px-4 max-md:pt-6 max-md:pb-10">
        <section>
          <div className="mb-6 px-1">
            <h1 className={cn(T.display, "text-foreground max-md:text-[26px]")}>
              {greeting()}
              {first ? `, ${first}` : ""}
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-[14px] text-muted-foreground max-md:text-[13px]">
              <Dot status="working" size={6} />
              <span>
                <span className="font-medium text-foreground">{all.filter((r) => r.status === "working").length}</span> working
              </span>
              <Sep />
              <Dot status="ready" size={6} />
              <span>
                <span className="font-medium text-foreground">{count("ready")}</span> PR ready
              </span>
              <Sep />
              <Dot status="queued" size={6} />
              <span>
                <span className="font-medium text-foreground">{all.filter((r) => r.status === "queued").length}</span> queued
              </span>
            </p>
          </div>
          <HeroComposer seed={seed} />
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2 px-1 max-md:-mx-4 max-md:justify-start max-md:flex-nowrap max-md:overflow-x-auto max-md:px-4 max-md:pb-1 max-md:[scrollbar-width:none] [&>button]:max-md:shrink-0">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSeed({ text: s, key: Date.now() })}
                className="h-8 rounded-[4px] border border-border px-3 text-[13px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-raised hover:text-foreground"
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-12 max-md:mt-8">
          <div className="mb-3 flex items-center gap-4 px-1 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-2">
            <h2 className={cn(T.title, "text-foreground")}>Runs</h2>
            <Tabs
              value={filter}
              onValueChange={(v) => setFilter(v as Filter)}

              className="max-md:order-3 max-md:-mx-4 max-md:w-[calc(100%+2rem)] max-md:overflow-x-auto max-md:px-4 max-md:[scrollbar-width:none]"
            >
              <TabsList className={tabs.list}>
                <TabsTrigger value="all" className={tabs.trigger}>
                  All
                </TabsTrigger>
                <TabsTrigger value="working" className={tabs.trigger}>
                  Working <span className="tabular-nums opacity-60">{count("working")}</span>
                </TabsTrigger>
                <TabsTrigger value="ready" className={tabs.trigger}>
                  PR ready <span className="tabular-nums opacity-60">{count("ready")}</span>
                </TabsTrigger>
                <TabsTrigger value="merged" className={tabs.trigger}>
                  Merged
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="ml-auto flex items-center gap-1.5">
              <Menu defaultOpen={devOpen("repo-filter")}>
                <MenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 rounded-[4px] px-3 text-[13px] text-muted-foreground hover:bg-raised hover:text-foreground"
                  >
                    {repo === "all" ? "All repositories" : repoName(repo)} <ChevronDown className="size-3.5" />
                  </button>
                </MenuTrigger>
                <MenuContent align="end" side="bottom" className="w-64">
                  <MenuLabel>Repository</MenuLabel>
                  <MenuRadioGroup value={repo} onValueChange={setRepo}>
                    {["all", ...repos].map((r) => (
                      <MenuRadioItem key={r} value={r}>
                        {r === "all" ? "All repositories" : r}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                </MenuContent>
              </Menu>
            </div>
          </div>
          {isLoading ? (
            <div className="h-[94px] rounded-[4px] border border-border bg-surface" />
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[4px] border border-dashed border-border-strong px-6 py-12 text-center">
              <span className="grid size-8 place-items-center rounded-[4px] border border-border bg-surface text-muted-foreground">
                <Check className="size-4" />
              </span>
              <p className="text-[14px] font-medium text-foreground">{all.length ? "Nothing here" : "No runs yet"}</p>
              <p className="max-w-sm text-[13px] text-muted-foreground">
                {all.length
                  ? "No runs match these filters."
                  : "Describe a task above. A agent clones the repo, does the work, and opens a pull request for you to review."}
              </p>
            </div>
          ) : (
            <ul className="overflow-hidden rounded-[4px] border border-border bg-surface">
              {shown.map((r, i) => (
                <RunRow key={r.id} run={r} first={i === 0} modelName={modelName(r.model_id)} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  )
}
