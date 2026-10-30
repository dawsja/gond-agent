import { ChevronDown, Clock, GitBranch, LoaderCircle, Lock, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react"
import { useMemo, useState } from "react"
import { Link } from "react-router"
import { GithubMark } from "@/components/brand/github"
import { ApiError, type Repo, type Runner } from "@/lib/api"
import { useBranches, useDeleteRunner, useGithub, useModels, useRepos, useSaveRunner, useSetRunnerEnabled, type RunnerInput } from "@/lib/queries"
import { cn } from "@/lib/utils"
import { PickerPopover } from "../studio/composer"
import { ModelMark, providerOf, PROVIDER_LABEL } from "../studio/parts"
import { Switch } from "../studio/switch"
import { mono, pickerChip } from "../studio/theme"

const chip = cn(pickerChip, "px-2.5")
/** One choice of a few: neutral grey, the chosen one raised. */
const segments = "inline-flex rounded-[4px] border border-border bg-inset p-0.5"
const segment = (on: boolean) => cn("h-7 rounded-[3px] px-2.5 text-[12.5px] transition-colors", on ? "bg-raised text-foreground" : "text-muted-foreground hover:text-foreground")
const field = "h-9 w-full rounded-[4px] border border-border-strong bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-subtle focus:border-primary"
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
/** Runners run on this browser's clock: there's no time zone to pick. */
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
/** Times offered in the time picker: every half hour (another minute can be typed, like 9:15). */
const TIMES = Array.from({ length: 48 }, (_, i) => i * 30)

/** "9:15", "9:15 pm", "21:15" or "9 am" → minutes after midnight, else null. */
function parseTime(text: string): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)?$/i.exec(text.trim())
  if (!m) return null
  let hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  const half = m[3]?.toLowerCase()[0]
  if (minute > 59 || hour > 23 || (half && (hour < 1 || hour > 12))) return null
  if (half === "p" && hour < 12) hour += 12
  if (half === "a" && hour === 12) hour = 0
  return hour * 60 + minute
}

function timeLabel(minute: number) {
  const hour = Math.floor(minute / 60)
  return `${hour % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`
}

export function describeRunner(runner: Pick<Runner, "frequency" | "weekdays" | "minute">) {
  const days = [...runner.weekdays].sort((a, b) => a - b)
  const when =
    runner.frequency === "daily" || days.length === 7
      ? "Every day"
      : days.length === 5 && days.every((day, i) => day === i)
        ? "Every weekday"
        : `Every ${days.map((day) => WEEKDAYS[day]).join(", ")}`
  return `${when} at ${timeLabel(runner.minute)}`
}

function nextLabel(ms: number) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms))
}

function Editor({ runner, onClose }: { runner?: Runner; onClose: () => void }) {
  const github = useGithub()
  const connected = !!github.data?.configured
  const repos = useRepos(connected)
  const models = useModels()
  const save = useSaveRunner()
  const remove = useDeleteRunner()
  const [name, setName] = useState(runner?.name ?? "")
  const [repo, setRepo] = useState<string | null>(runner?.repo ?? null)
  const [branch, setBranch] = useState<string | null>(runner?.base_branch ?? null)
  const [model, setModel] = useState(runner?.model_id ?? "")
  const [prompt, setPrompt] = useState(runner?.prompt ?? "")
  const [frequency, setFrequency] = useState<Runner["frequency"]>(runner?.frequency ?? "weekly")
  const [days, setDays] = useState<number[]>(runner?.weekdays.length ? runner.weekdays : [0])
  const [minute, setMinute] = useState(runner?.minute ?? 9 * 60)
  const [error, setError] = useState<string | null>(null)
  const freeText = github.data?.configured === false
  const repoList = repos.data ?? []
  const selectedRepo = repoList.find((item) => item.full_name === repo)
  const branches = useBranches(connected && repo ? repo : null)
  const modelList = useMemo(() => models.data ?? [], [models.data])
  const modelId = model && modelList.some((item) => item.id === model) ? model : (modelList[0]?.id ?? "")

  const submit = () => {
    setError(null)
    const input: RunnerInput & { id?: string } = {
      id: runner?.id,
      name: name.trim(),
      repo: repo ?? "",
      base_branch: branch ?? undefined,
      model_id: modelId,
      prompt: prompt.trim(),
      frequency,
      weekdays: frequency === "weekly" ? days : [],
      minute,
      timezone: BROWSER_ZONE,
      enabled: runner?.enabled ?? true,
    }
    save.mutate(input, {
      onSuccess: onClose,
      onError: (e) => setError(e instanceof ApiError ? e.message : "Couldn't save that runner."),
    })
  }

  return (
    <div className="border-t border-border px-5 py-4 max-md:px-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-[12px] text-muted-foreground">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={cn(field, "mt-1")} placeholder="Monday tests" />
        </label>
        <label className="block text-[12px] text-muted-foreground">
          Repository
          <div className="mt-1">
            <PickerPopover
              value={repo}
              onSelect={(value) => {
                setRepo(value)
                setBranch(null)
              }}
              placeholder={freeText ? "owner/name" : "Search repositories"}
              allowCustom={freeText ? (value) => /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(value) : undefined}
              empty={connected || freeText ? "No repositories yet" : "Connect GitHub in Plugins first"}
              items={(freeText ? [] : repoList).map((item: Repo) => ({ value: item.full_name, label: item.full_name, hint: item.private ? <Lock className="size-3" /> : undefined }))}
              trigger={<button type="button" className={cn(chip, "w-full")}><GithubMark className="size-3" /><span className="min-w-0 flex-1 truncate text-left">{repo ?? "Choose a repository"}</span><ChevronDown className="size-3.5 text-muted-foreground" /></button>}
            />
          </div>
        </label>
      </div>
      <label className="mt-3 block text-[12px] text-muted-foreground">
        Prompt
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={20_000} rows={5} className="mt-1 w-full resize-y rounded-[4px] border border-border-strong bg-background px-3 py-2 text-[13px] leading-6 text-foreground outline-none placeholder:text-subtle focus:border-primary" placeholder="What should the agent do each time?" />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="How often" className={segments}>
          {(["daily", "weekly"] as const).map((item) => (
            <button key={item} type="button" role="radio" aria-checked={frequency === item} onClick={() => setFrequency(item)} className={segment(frequency === item)}>
              {item === "daily" ? "Daily" : "Weekly"}
            </button>
          ))}
        </div>
        {/* Daily runs every day: the days are greyed out until Weekly is chosen (and keep their choice). */}
        <div role="group" aria-label="Days" aria-disabled={frequency === "daily"} className={cn(segments, frequency === "daily" && "opacity-45")}>
          {WEEKDAYS.map((label, day) => {
            const on = frequency === "weekly" && days.includes(day)
            return (
              <button
                key={label}
                type="button"
                disabled={frequency === "daily"}
                aria-pressed={on}
                onClick={() => setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day]))}
                className={cn(segment(on), "disabled:cursor-not-allowed disabled:hover:text-muted-foreground")}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <PickerPopover
          value={`t${minute}`}
          onSelect={(value) => {
            const next = value.startsWith("t") ? Number(value.slice(1)) : parseTime(value)
            if (next !== null) setMinute(next)
          }}
          placeholder="Type a time, like 9:15"
          allowCustom={(value) => parseTime(value) !== null}
          width="w-60"
          items={TIMES.map((m) => ({ value: `t${m}`, label: timeLabel(m), search: timeLabel(m).replace(" ", "").toLowerCase() }))}
          trigger={
            <button type="button" aria-label="Time" className={chip}>
              <Clock className="size-3.5 text-muted-foreground" />
              <span className="tabular-nums">{timeLabel(minute)}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </button>
          }
        />
        <PickerPopover value={branch} onSelect={setBranch} placeholder="Base branch" allowCustom={(value) => /^[A-Za-z0-9._/-]{1,200}$/.test(value)} items={(branches.data ?? [selectedRepo?.default_branch].filter((item): item is string => !!item)).map((item) => ({ value: item, label: <span style={mono}>{item}</span> }))} trigger={<button type="button" className={chip} disabled={!repo}><GitBranch className="size-3.5 text-muted-foreground" /><span style={mono}>{branch ?? selectedRepo?.default_branch ?? "Default branch"}</span></button>} />
        <PickerPopover value={modelId} onSelect={setModel} placeholder="Search models" items={modelList.map((item) => ({ value: item.id, label: <span className="flex items-center gap-2"><ModelMark id={item.id} size={15} />{item.display_name}</span>,  group: PROVIDER_LABEL[providerOf(item.id)] ?? item.provider, search: item.display_name }))} trigger={<button type="button" className={chip}>{modelId && <ModelMark id={modelId} size={15} />}<span className="max-w-40 truncate">{modelList.find((item) => item.id === modelId)?.display_name ?? "Model"}</span></button>} />
      </div>
      <p className="mt-3 text-[13px] text-muted-foreground">{describeRunner({ frequency, weekdays: days, minute })}, your time</p>
      {error && <p className="mt-2 text-[13px] text-failed">{error}</p>}
      <div className="mt-4 flex items-center gap-2">
        <button type="button" onClick={submit} disabled={save.isPending || !name.trim() || !repo || !prompt.trim() || !modelId || (frequency === "weekly" && days.length === 0)} className="inline-flex h-8 items-center gap-1.5 rounded-[4px] bg-primary px-3 text-[13px] font-medium text-primary-foreground disabled:opacity-50">{save.isPending && <LoaderCircle className="size-3.5 animate-spin" />}Save</button>
        <button type="button" onClick={onClose} className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-border-strong px-3 text-[13px]"><X className="size-3.5" />Cancel</button>
        {runner && <button type="button" onClick={() => remove.mutate(runner.id, { onSuccess: onClose, onError: (e) => setError(e instanceof ApiError ? e.message : "Couldn't delete that runner.") })} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-[4px] px-2 text-[13px] text-failed hover:bg-raised"><Trash2 className="size-3.5" />Delete</button>}
      </div>
    </div>
  )
}

/** What happened the last scheduled time: the run it started, or why it didn't start one. */
function LastRun({ runner }: { runner: Runner }) {
  const last = runner.last
  if (!last || last.status === "claimed") return null
  const when = nextLabel(last.at)
  if (last.status === "started" && last.run_id) {
    return (
      <p className="mt-1 text-[12px] text-muted-foreground">
        Last run: {when} ·{" "}
        <Link to={`/runs/${last.run_id}`} className="text-link hover:underline">
          Open run
        </Link>
      </p>
    )
  }
  return (
    <p className="mt-1 flex items-start gap-1.5 text-[12px] text-muted-foreground">
      <TriangleAlert className="mt-px size-3.5 shrink-0 text-working" />
      <span>
        {when}: {last.status === "skipped" ? "skipped" : "didn't start"}. {last.reason}
      </span>
    </p>
  )
}

export function RunnerCard({ runner, disabled, editing, onEdit }: { runner: Runner; disabled: boolean; editing: boolean; onEdit: () => void }) {
  const save = useSetRunnerEnabled()
  return (
    <section className={cn("rounded-[4px] border border-border bg-surface", disabled && "opacity-60")}>
      <header className="flex items-start justify-between gap-3 px-5 py-4 max-md:px-4">
        <div className="min-w-0">
          <h3 className="truncate text-[14px] font-semibold text-foreground">{runner.name}</h3>
          <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{runner.prompt}</p>
          <p className="mt-2 text-[12px] text-muted-foreground" style={mono}>{runner.repo} · {describeRunner(runner)}{runner.timezone !== BROWSER_ZONE && ` (${runner.timezone} time)`}</p>
          {runner.enabled && runner.next_run_at && <p className="mt-1 text-[12px] text-muted-foreground">Next run: {nextLabel(runner.next_run_at)}</p>}
          <LastRun runner={runner} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button type="button" aria-label={`Edit ${runner.name}`} disabled={disabled} onClick={onEdit} className="grid size-8 place-items-center rounded-[4px] border border-border text-foreground hover:bg-raised disabled:opacity-50"><Pencil className="size-3.5" /></button>
          <Switch checked={runner.enabled && !disabled} disabled={disabled || save.isPending} onChange={(enabled) => save.mutate({ id: runner.id, enabled })} label={`Enable ${runner.name}`} />
        </div>
      </header>
      {editing && <Editor runner={runner} onClose={onEdit} />}
    </section>
  )
}

export function RunnerCreator({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-[4px] border border-border bg-surface">
      <header className="flex items-start justify-between gap-4 px-5 py-4 max-md:flex-col max-md:px-4">
        <div>
          <h2 className="text-[14px] font-semibold text-foreground">Gond Agent Runners</h2>
          <p className="mt-0.5 max-w-[60ch] text-[13px] text-muted-foreground">Run a saved prompt on a schedule. Each run starts in its own worker container.</p>
        </div>
        <button type="button" disabled={disabled} onClick={() => setOpen((value) => !value)} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[4px] border border-border-strong px-3 text-[13px] font-medium hover:bg-raised disabled:opacity-50"><Plus className="size-3.5" />Create runner</button>
      </header>
      {open && !disabled && <Editor onClose={() => setOpen(false)} />}
    </section>
  )
}
