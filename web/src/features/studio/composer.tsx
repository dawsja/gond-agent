import { EffortPicker, effortFor } from "@/components/workspace/effort-picker"
import { Check, ChevronDown, GitBranch, Lock, Search } from "lucide-react"
import { Popover } from "radix-ui"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { GithubMark } from "@/components/brand/github"
import { TaskInput } from "@/components/workspace/task-input"
import { useBranches, useCreateRun, useGithub, useModelCatalog, useRefreshModels, useRepos, useRuns } from "@/lib/queries"
import { Button } from "@shared/ui/button"
import { devOpen } from "@/lib/dev-open"
import { useImageAttachments } from "@/lib/images"
import { cn } from "@/lib/utils"
import { AttachButton, DropHint, ImageTray } from "./attachments"
import { ModelMark, providerOf, PROVIDER_LABEL } from "./parts"
import { mono, pickerChip as chip } from "./theme"
import { prefs } from "@/lib/prefs"

/**
 * A searchable list in a popover. Free text is accepted when `allowCustom` validates it. The reference for
 * every picker (the composer's repository, branch and model; Gond Agent Runners).
 */
export function PickerPopover({
  trigger,
  items,
  value,
  onSelect,
  placeholder,
  allowCustom,
  empty,
  width = "w-80",
  name,
  align = "start",
  footer,
}: {
  trigger: ReactNode
  /** `group` puts items under headings (in order of first appearance); `search` is extra text to match. */
  items: { value: string; label: ReactNode; hint?: ReactNode; group?: string; search?: string }[]
  value: string | null
  onSelect: (v: string) => void
  placeholder: string
  allowCustom?: (q: string) => boolean
  empty?: ReactNode
  width?: string
  name?: string
  align?: "start" | "end"
  footer?: ReactNode
}) {
  const [open, setOpen] = useState(() => !!name && devOpen(name))
  const [q, setQ] = useState("")
  const needle = q.trim().toLowerCase()
  const matches = items.filter((i) => `${i.value} ${i.search ?? ""} ${i.group ?? ""}`.toLowerCase().includes(needle))
  const shown = matches.slice(0, 50)
  const custom = q.trim() && allowCustom?.(q.trim()) && !items.some((i) => i.value === q.trim()) ? q.trim() : null
  // Opens on the selected item (a long list, like times of day, would otherwise hide it).
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (!open) return
    const raf = requestAnimationFrame(() => list.current?.querySelector("[data-selected]")?.scrollIntoView({ block: "center" }))
    return () => cancelAnimationFrame(raf)
  }, [open])
  const pick = (v: string) => {
    onSelect(v)
    setOpen(false)
    setQ("")
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align={align}
          sideOffset={6}
          className={cn("z-50 overflow-hidden rounded-[4px] border border-border-strong bg-popover text-foreground", width)}
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  if (custom) pick(custom)
                  else if (shown[0]) pick(shown[0].value)
                }
              }}
              placeholder={placeholder}
              className="h-9 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
            />
          </div>
          <ul ref={list} className="max-h-72 overflow-y-auto p-1">
            {custom && (
              <li>
                <button type="button" onClick={() => pick(custom)} className="flex h-8 w-full items-center gap-2 rounded-[3px] px-2 text-left text-[13px] hover:bg-raised">
                  Use <span style={mono}>{custom}</span>
                </button>
              </li>
            )}
            {shown.map((i, n) => (
              <li key={i.value}>
                {i.group && i.group !== shown[n - 1]?.group && (
                  <div className={cn("px-2 pt-2 pb-1 text-[11px] text-subtle", n > 0 && "mt-1 border-t border-border")}>{i.group}</div>
                )}
                <button
                  type="button"
                  data-selected={i.value === value || undefined}
                  onClick={() => pick(i.value)}
                  className="flex h-8 w-full items-center gap-2 rounded-[3px] px-2 text-left text-[13px] hover:bg-raised"
                >
                  <span className="min-w-0 flex-1 truncate">{i.label}</span>
                  {i.hint && <span className="shrink-0 text-[12px] text-muted-foreground">{i.hint}</span>}
                  <Check className={cn("size-3.5 shrink-0 text-foreground", i.value !== value && "invisible")} />
                </button>
              </li>
            ))}
            {!custom && shown.length === 0 && <li className="px-2 py-2 text-[12px] text-muted-foreground">{empty ?? "Nothing matches"}</li>}
            {matches.length > shown.length && <li className="px-2 py-2 text-[12px] text-muted-foreground">Showing {shown.length} of {matches.length}. Search to narrow the list.</li>}
          </ul>
          {footer && <div className="flex items-center justify-between gap-2 border-t border-border p-2">{footer}</div>}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

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
          <EffortPicker model={modelInfo} value={effort} onChange={setEffort} />
          <AttachButton onClick={attach.pick} count={attach.items.length} disabled={needsGithub || !repo} />
            <PickerPopover
              name="model"
              value={modelId}
              onSelect={(v) => {
                setModel(v)
                prefs.set("model", v)
              }}
              width="w-72"
              placeholder="Search models"
              empty={models.isPending ? "Loading models…" : "No models available. Check your connections in Settings."}
              footer={<><Button variant="ghost" size="sm" disabled={refreshModels.isPending} onClick={() => refreshModels.mutate()}>{refreshModels.isPending ? "Refreshing…" : "Refresh models"}</Button><Button asChild variant="link" size="sm"><a href="/agents/settings#providers">Providers</a></Button></>}
              items={modelList.map((m) => {
                const provider = providerOf(m.id)
                return {
                  value: m.id,
                  label: (
                    <span className="flex items-center gap-2">
                      <ModelMark id={m.id} size={15} />
                      {m.display_name}
                    </span>
                  ),

                  group: m.provider === "auto" ? "Automatic" : m.connection_name ?? PROVIDER_LABEL[provider] ?? m.provider,
                  search: m.display_name,
                }
              })}
              trigger={
                <button type="button" aria-label="Choose model" className={cn(chip, "ml-0.5 gap-1.5 px-2.5")}>
                  {modelInfo && <ModelMark id={modelInfo.id} size={15} />}
                  <span className="max-w-[180px] truncate max-md:max-w-[120px]">{modelInfo?.display_name ?? (models.isPending ? "Loading models…" : "No models available")}</span>

                  <ChevronDown className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                </button>
              }
            />
        </>}
      ><DropHint show={attach.dragging} /><ImageTray items={attach.items} onRemove={attach.remove} className="px-4 pt-3" /></TaskInput>
      {(attach.error ?? create.error) && (
        <p className="mt-2 px-1 text-[13px] text-failed">{attach.error ?? create.error?.message}</p>
      )}
      {(models.error ?? refreshModels.error) && <p role="alert" className="mt-2 px-1 text-[13px] text-failed">{(models.error ?? refreshModels.error)?.message}</p>}
      {models.data?.connections?.filter(c => c.message).map(c => <p key={c.id} role="status" className="mt-2 px-1 text-[12px] text-muted-foreground">{c.name}: {c.message}</p>)}
    </div>
  )
}
