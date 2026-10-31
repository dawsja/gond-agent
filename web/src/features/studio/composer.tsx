import { EffortPicker, effortFor } from "@/components/workspace/effort-picker"
import { ChevronDown, GitBranch, Lock } from "lucide-react"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router"
import { GithubMark } from "@/components/brand/github"
import { TaskInput } from "@/components/workspace/task-input"
import { PickerPopover } from "@/components/workspace/picker-popover"
import { ModelPicker } from "@/components/workspace/model-picker"
import { useBranches, useCreateRun, useGithub, useModelCatalog, useRefreshModels, useRepos, useRuns } from "@/lib/queries"
import { Button } from "@shared/ui/button"
import { useImageAttachments } from "@/lib/images"
import { cn } from "@/lib/utils"
import { AttachButton, DropHint, ImageTray } from "./attachments"
import { mono, pickerChip as chip } from "./theme"
import { prefs } from "@/lib/prefs"

const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/

export function HeroComposer({ seed }: { seed?: { text: string; key: number } }) {
  const navigate = useNavigate()
  const github = useGithub()
  const connected = !!github.data?.configured
  const repos = useRepos(connected)
  const models = useModelCatalog()
  const refreshModels = useRefreshModels()
  const create = useCreateRun()
  const attach = useImageAttachments()

  const [picked, setRepo] = useState<string | null>(() => prefs.get("repo"))
  const [base, setBase] = useState<string | null>(null)
  const [effort, setEffort] = useState("default")
  const [model, setModel] = useState<string | null>(() => prefs.get("model"))

  // The picked repo if this workspace can see it, else the most recently pushed one. Without the
  // host GitHub session any typed owner/name goes.
  const list = repos.data
  const runs = useRuns().data
  const last = runs?.[0]
  const lastRun = last?.repo ?? null
  const repo =
    github.data?.configured === false
      ? (picked ?? lastRun)
      : picked && list?.some((r) => r.full_name === picked)
        ? picked
        : (list?.[0]?.full_name ?? null)

  const modelList = useMemo(() => models.data?.models ?? [], [models.data])
  const modelId = model && modelList.some((m) => m.id === model) ? model : (modelList[0]?.id ?? "")
  const repoInfo = repos.data?.find((r) => r.full_name === repo)
  const branches = useBranches(connected && repo ? repo : null)
  const target =
    base ?? repoInfo?.default_branch ?? (github.data?.configured === false ? (last?.repo === repo ? last.base_branch : "main") : null)
  const modelInfo = modelList.find((m) => m.id === modelId)

  const choose = (r: string) => {
    setRepo(r)
    setBase(null)
    prefs.set("repo", r)
  }

  const needsGithub = !github.isPending && !connected
  // Configured instances can start container-backed runs.
  const freeText = github.data?.configured === false

  const submit = (text: string) => {
    if (!repo || !modelId || !text.trim() || attach.busy) return
    create.mutate(
      { repo, base_branch: target ?? undefined, model: modelId, effort: effortFor(modelInfo, effort), prompt: text, images: attach.images() },
      {
        onSuccess: (run) => {
          attach.clear()
          navigate(`/runs/${run.id}`)
        },
      },
    )
  }

  const [owner, name] = repo?.split("/") ?? []
  return (
    <div {...attach.handlers}>
      <div className="mb-2 flex items-center gap-2">
        {needsGithub ? (
          <button type="button" onClick={() => navigate("/plugins")} className={cn(chip, "pr-2.5 pl-1.5")}>
            <span className="grid size-5 place-items-center rounded-[3px] bg-raised"><GithubMark className="size-3 text-foreground" /></span>
            Connect GitHub to pick a repository
          </button>
        ) : (
          <PickerPopover
            name="repo"
            value={repo}
            onSelect={choose}
            placeholder={freeText ? "owner/name of a public repo" : "Search repositories"}
            allowCustom={freeText ? (q) => REPO_RE.test(q) : undefined}
            empty={freeText ? "Type owner/name, e.g. octocat/Hello-World" : "No repositories found for the host GitHub account."}
            items={(freeText
              ? [...new Set((runs ?? []).map((r) => r.repo))].map((full_name) => ({ full_name, private: false }))
              : (repos.data ?? [])
            ).map((r) => ({
              value: r.full_name,
              label: r.full_name,
              hint: r.private ? <Lock className="size-3" /> : undefined,
            }))}
            trigger={
              <button type="button" className={cn(chip, "pr-2.5 pl-1.5")}>
                <span className="grid size-5 place-items-center rounded-[3px] bg-raised"><GithubMark className="size-3 text-foreground" /></span>
                {repo ? (
                  <>
                    <span className="whitespace-nowrap text-muted-foreground max-md:hidden">{owner} /</span>
                    <span className="-ml-1 max-w-[180px] truncate font-medium max-md:ml-0 max-md:max-w-[140px]">{name}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">{freeText ? "Choose a repository" : "Loading repositories…"}</span>
                )}
                <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </button>
            }
          />
        )}
        {!needsGithub && repo && (
          <PickerPopover
            name="branch"
            value={target}
            onSelect={setBase}
            width="w-64"
            placeholder="Base branch"
            allowCustom={(q) => /^[A-Za-z0-9._/-]{1,200}$/.test(q)}
            items={(freeText
              ? [...new Set([target, ...(runs ?? []).filter((r) => r.repo === repo).map((r) => r.base_branch)].filter((b): b is string => !!b))]
              : (branches.data ?? [])
            ).map((b) => ({ value: b, label: <span style={mono}>{b}</span> }))}
            trigger={
              <button type="button" className={cn(chip, "gap-1.5 px-2.5")}>
                <GitBranch className="size-3.5 text-muted-foreground" />
                <span style={mono} className="text-[12px]">
                  {target ?? "…"}
                </span>
                <ChevronDown className="size-3.5 text-muted-foreground" />
              </button>
            }
          />
        )}
      </div>
      <input {...attach.inputProps} />
      <TaskInput
        key={seed?.key}
        defaultValue={seed?.text}
        placeholder="Describe a task. An agent builds it and opens a pull request."
        busy={create.isPending || attach.busy}
        disabled={needsGithub || !repo || !modelInfo}
        onSubmit={submit}
        footer={<>
          <AttachButton onClick={attach.pick} count={attach.items.length} disabled={needsGithub || !repo} />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <ModelPicker
              models={modelList}
              value={modelId}
              onChange={(v) => {
                setModel(v)
                setEffort("default")
                prefs.set("model", v)
              }}
              loading={models.isPending}
              footer={<><Button variant="ghost" size="sm" disabled={refreshModels.isPending} onClick={() => refreshModels.mutate()}>{refreshModels.isPending ? "Refreshing…" : "Refresh models"}</Button><Button asChild variant="link" size="sm"><a href="/agents/settings#providers">Providers</a></Button></>}
            />
            <EffortPicker model={modelInfo} value={effort} onChange={setEffort} />
          </div>
        </>}
      ><DropHint show={attach.dragging} /><ImageTray items={attach.items} onRemove={attach.remove} className="px-4 pt-3" /></TaskInput>
      {(attach.error ?? create.error) && (
        <p className="mt-2 px-1 text-[13px] text-failed">{attach.error ?? create.error?.message}</p>
      )}
      {(models.error ?? refreshModels.error) && <p role="alert" className="mt-2 px-1 text-[13px] text-failed">{(models.error ?? refreshModels.error)?.message}</p>}
      {models.data?.connections?.filter(c => c.message && !modelInfo?.backend && (!modelInfo || c.id === modelInfo.connection_id)).map(c => <p key={c.id} role="status" className="mt-2 px-1 text-[12px] text-muted-foreground">{c.name}: {c.message}</p>)}
    </div>
  )
}
