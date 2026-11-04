import { ModelPicker } from "@/components/workspace/model-picker"
import { EffortPicker, effortFor } from "@/components/workspace/effort-picker"
import { ChevronRight, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, MoreHorizontal, PanelRightClose, PanelRightOpen, Square, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"
import { useNavigate, useParams } from "react-router"
import { Tabs, TabsList, TabsTrigger } from "@shared/ui/tabs"
import { Button } from "@shared/ui/button"
import { FollowUpInput } from "@/components/workspace/task-input"
import { QueueReason } from "./queue-reason"
import { queueLabel, runElapsed } from "@/lib/format"
import { useCloseRun, useDeleteRun, useMe, useModelCatalog, useResumeRun, useRun, useSendMessage, useStopRun } from "@/lib/queries"
import { PlanIndicator } from "../settings/chatgpt-plan"
import { useRunStream } from "@/lib/run-stream"
import { devOpen } from "@/lib/dev-open"
import { useImageAttachments } from "@/lib/images"
import { cn } from "@/lib/utils"
import { AttachButton, DropHint, ImageTray } from "../studio/attachments"
import { ConfirmDialog } from "../studio/confirm-dialog"
import { StatusPill } from "../studio/parts"
import { Shell } from "../studio/shell"
import { mono, tabs } from "../studio/theme"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@shared/menu"
import { SidePanel } from "./side-panel"
import { TranscriptView } from "./transcript-view"
import { prefs } from "@/lib/prefs"
import { ScrollToBottomButton } from "./scroll-to-bottom-button"
import { useStickToBottom } from "./use-stick-to-bottom"

export function RunScreen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const run = useRun(id)
  const { data: me } = useMe()
  const { data: catalog } = useModelCatalog(), models = catalog?.models
  const stream = useRunStream(id)
  const stop = useStopRun()
  const resume = useResumeRun()
  const close = useCloseRun()
  const del = useDeleteRun()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const send = useSendMessage()
  const [pickedModel,setPickedModel]=useState("")
  const [effort,setEffort]=useState<string | null>(null)
  const attach = useImageAttachments()
  const [draft, setDraft] = useState("")
  const t = stream.transcript
  const [view, setView] = useState<"chat" | "details">(() => (devOpen("details") ? "details" : "chat"))
  // Desktop only: phones switch between the two with tabs instead.
  const [panel, setPanel] = useState(() => prefs.get("runPanel") !== "hidden" && !devOpen("no-details"))
  const togglePanel = () => {
    prefs.set("runPanel", !panel ? "shown" : "hidden")
    setPanel(!panel)
  }
  const refetch = run.refetch

  // Status changes on the stream refresh the run row (diffstat, PR).
  const statusKey = `${t.status}:${t.queueRevision}:${t.committed}:${t.items.filter((i) => i.kind === "pr").map(i => `${i.number}:${i.state}`).join(",")}`
  useEffect(() => {
    void refetch()
  }, [statusKey, refetch])

  const { scroller, content, composer, resumeFollowing, shown, scrollToBottom } = useStickToBottom(t, !!run.data)

  if (run.error) {
    return (
      <Shell active="Home" crumbs={<span className="text-muted-foreground">Runs</span>}>
        <div className="grid h-full place-items-center text-[14px] text-muted-foreground">{run.error.message}</div>
      </Shell>
    )
  }
  const r = run.data
  if (!r) return <Shell active="Home" crumbs={<span className="text-muted-foreground">Runs</span>} children={null} />

  const live = r.status === "working" || r.status === "queued"
  const merged = r.status === "merged" || r.pr_state === "merged"
  const retired = !!r.retired_backend
  const interrupted = r.status === "interrupted"
  const PullIcon = merged ? GitMerge : r.pr_state === "closed" ? GitPullRequestClosed : GitPullRequest
  const author = r.user_id === me?.user?.id ? (me?.user?.name ?? "You") : (r.user_name ?? "Teammate")
  const modelName = models?.find((m) => m.id === r.model_id)?.display_name
  const pill = live ? (
    <StatusPill status={r.status}>
      {r.status === "queued" ? "Queued" : `Working · ${runElapsed(r) ?? "0s"}`}
    </StatusPill>
  ) : merged ? <StatusPill status="merged" /> : r.status === "ready" && r.pr_number && r.pr_state !== "closed" ? (
    <StatusPill status="ready">PR ready · #{r.pr_number}</StatusPill>
  ) : (
    <StatusPill status={r.status}>{r.status === "ready" ? "Ready" : undefined}</StatusPill>
  )

  return (
    <Shell
      active="Home"
      activeRun={r.id}
      crumbs={
        <>
          <button type="button" onClick={() => navigate("/")} className="text-muted-foreground hover:text-foreground max-md:hidden">
            Runs
          </button>
          <ChevronRight className="size-3.5 text-subtle max-md:hidden" />
          <span className="max-w-[360px] truncate font-medium text-foreground">{r.title}</span>
          <span className="ml-1 shrink-0 max-md:hidden">{pill}</span>
        </>
      }
      actions={
        <>
          {r.pr_url && (
            <a
              href={r.pr_url}
              target="_blank"
              rel="noreferrer"
              aria-label={`${merged ? "Merged" : r.pr_state === "closed" ? "Closed" : "Open"} pull request #${r.pr_number}`}
              className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-border px-3 text-[13px] text-foreground transition-colors hover:bg-raised"
            >
              <PullIcon className={cn("size-3.5", merged ? "text-merged" : r.pr_state === "closed" ? "text-failed" : "text-muted-foreground")} />
              <span style={mono} className="text-[12px]">
                #{r.pr_number}
              </span>
              <ExternalLink className="size-3.5 text-muted-foreground max-md:hidden" />
            </a>
          )}
          {live && (
            <button
              type="button"
              disabled={stop.isPending}
              onClick={() => stop.mutate({ id: r.id, arg: undefined })}
              aria-label={r.status === "queued" ? "Cancel" : "Stop"}
              className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-border px-3 text-[13px] text-foreground transition-colors hover:bg-raised max-md:px-2.5"
            >
              <Square className="size-3 fill-current" />
              <span className={r.status === "queued" ? "" : "max-md:hidden"}>{r.status === "queued" ? "Cancel" : "Stop"}</span>
            </button>
          )}
          <ConfirmDialog
            open={confirmDelete}
            title="Delete this run?"
            body="It disappears now and is erased within 30 days. Its worker container is removed. Pull requests on GitHub stay."
            confirmLabel="Delete run"
            busy={del.isPending}
            error={del.error?.message}
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => del.mutate({ id: r.id, arg: undefined }, { onSuccess: () => navigate("/") })}
          />
          <button
            type="button"
            onClick={togglePanel}
            aria-label={panel ? "Hide details" : "Show details"}
            aria-pressed={panel}
            title={panel ? "Hide details" : "Show details"}
            className="grid size-8 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-raised hover:text-foreground max-md:hidden"
          >
            {panel ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
          </button>
          <Menu defaultOpen={devOpen("run-more")}>
            <MenuTrigger asChild>
              <button type="button" aria-label="More" className="grid size-8 place-items-center rounded-[4px] text-muted-foreground transition-colors hover:bg-raised hover:text-foreground">
                <MoreHorizontal className="size-4" />
              </button>
            </MenuTrigger>
            <MenuContent align="end" side="bottom" className="w-48">
              {!live && <MenuItem disabled={close.isPending} onSelect={() => close.mutate({ id: r.id, arg: undefined })}>
                Close workspace
              </MenuItem>}
              <MenuItem className="text-destructive" onSelect={() => setConfirmDelete(true)}>
                <Trash2 className="size-3.5" />
                <span className="min-w-0 flex-1 truncate">Delete run</span>
              </MenuItem>
            </MenuContent>
          </Menu>
        </>
      }
      contentClassName={cn(
        "grid overflow-hidden max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]",
        panel ? "grid-cols-[minmax(0,1fr)_500px]" : "grid-cols-1",
      )}
    >
      {/* Phones: one column at a time. */}
      <div className="hidden items-center gap-3 border-b border-border px-3 py-2 max-md:flex">
        <Tabs value={view} onValueChange={(v) => setView(v as "chat" | "details")} className="min-w-0 flex-1">
          <TabsList className={cn(tabs.list, "grid w-full grid-cols-2")}>
            <TabsTrigger value="chat" className={cn(tabs.trigger, "w-full justify-center")}>
              Transcript
            </TabsTrigger>
            <TabsTrigger value="details" className={cn(tabs.trigger, "w-full justify-center")}>
              Changes &amp; PR
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="shrink-0">{pill}</span>
      </div>
      <section className={cn("relative flex min-h-0 flex-col", view === "details" && "max-md:hidden")}>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-background to-transparent" />
        <div
          ref={scroller}
          data-run-scroller
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div ref={content} data-run-content>
            <TranscriptView run={r} t={t} author={author} />
          </div>
        </div>
        <ScrollToBottomButton shown={shown} onClick={scrollToBottom} />
        <div ref={composer} data-run-composer {...attach.handlers} className="relative mx-auto w-full max-w-[720px] px-8 pt-2 pb-5 max-md:px-3 max-md:pb-3">
          {r.status === "queued" && <div role="status" className="mb-3 px-1 text-[13px] text-muted-foreground"><p>{queueLabel(r)}</p><QueueReason run={r} /></div>}
          {interrupted && !merged && !retired && (
            <div className="mb-3 flex flex-wrap items-center gap-2 px-1">
              <p role="status" className="min-w-0 flex-1 text-[13px] text-muted-foreground">Interrupted. Resume to continue from saved progress.</p>
              <Button variant="outline" size="sm" disabled={stop.isPending || resume.isPending} onClick={() => stop.mutate({ id: r.id, arg: undefined })}>Stop</Button>
              <Button size="sm" disabled={resume.isPending || stop.isPending} onClick={() => resume.mutate({ id: r.id, arg: undefined })}>{resume.isPending ? "Resuming…" : "Resume"}</Button>
            </div>
          )}
          <DropHint show={attach.dragging} />
          <input {...attach.inputProps} />
          <ImageTray items={attach.items} onRemove={attach.remove} className="mb-2" />
          <FollowUpInput
            disabled={merged || retired || interrupted || send.isPending || attach.busy}
            attached={attach.items.length}
            value={draft}
            onValueChange={setDraft}
            leading={<><AttachButton onClick={attach.pick} count={attach.items.length} disabled={merged || retired || interrupted} /><div className="flex min-w-0 flex-1 items-center gap-2"><ModelPicker models={models?.filter(m => m.id !== "auto") ?? []} value={pickedModel || r.model_id} label="Follow-up model" disabled={merged || retired || interrupted} onChange={value => { setPickedModel(value); setEffort("default") }} /><EffortPicker model={models?.find(m => m.id === (pickedModel || r.model_id))} value={effort ?? r.effort ?? "default"} onChange={setEffort} disabled={merged || retired || interrupted} /></div></>}
            placeholder={
              retired
                ? "Claude Code and Codex agents were removed. Start a new run to continue."
                : merged
                ? "This pull request is merged"
                : interrupted
                  ? "Resume this run to continue"
                : r.status === "stopped" && !r.error
                  ? "Tell the agent what to do instead"
                  : r.status === "failed" && r.live?.phase === "agent"
                    ? "Send a message to continue"
                  : live
                  ? "Steer this agent, or add to the task"
                  : r.pr_number
                    ? "Ask for follow-up changes to this PR"
                    : "Ask for follow-up changes"
            }
            onSubmit={(p) => {
              const images = attach.images()
              if (!p && !images.length) return
              resumeFollowing()
              // REST rather than the socket, so a refused follow-up (merged, expired) shows its reason.
              send.mutate({ id: r.id, arg: { text: p, images, model:pickedModel || undefined, effort:effortFor(models?.find(m=>m.id===(pickedModel || r.model_id)),effort ?? r.effort ?? "default") } }, { onSuccess: () => { attach.clear(); setDraft("") } })
            }}
          />
          {!retired && <PlanIndicator model={models?.find(m => m.id === (pickedModel || r.model_id))} connections={catalog?.connections} />}
          {(attach.error ?? send.error ?? resume.error ?? stop.error ?? close.error) && (
            <p className="mt-2 px-1 text-[12px] text-failed">{attach.error ?? send.error?.message ?? resume.error?.message ?? stop.error?.message ?? close.error?.message}</p>
          )}
        </div>
      </section>
      <SidePanel run={r} t={t} modelName={modelName} className={cn(view === "chat" && "max-md:hidden", !panel && "md:hidden")} />
    </Shell>
  )
}
