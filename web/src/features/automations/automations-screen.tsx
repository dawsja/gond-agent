import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Me } from "@/lib/api"
import { useMe, useRunners } from "@/lib/queries"
import { Section } from "../studio/section"
import { Shell } from "../studio/shell"
import { Switch } from "@shared/ui/switch"
import { RunnerCard, RunnerCreator } from "./runners"
export function AutomationsScreen() {
  const [editing, setEditing] = useState<string | null>(null)
  const { data: me } = useMe(), runners = useRunners(), qc = useQueryClient()
  const save = useMutation({ mutationFn: (body: Partial<NonNullable<Me["automations"]>>) => api("/v1/me/automations", { method: "PUT", body }), onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }) })
  return <Shell active="Automations" crumbs={<span>Automations</span>} contentClassName="overflow-y-auto"><div className="mx-auto w-full max-w-[900px] space-y-5 px-5 py-10"><h1 className="text-3xl font-semibold">Automations</h1>
    <Section title="Pull requests" description="Choose whether a finished run opens a pull request automatically."><div className="flex items-center justify-between gap-4 border-t border-border p-5 text-sm"><label htmlFor="auto-pr">Open pull requests automatically</label><Switch id="auto-pr" checked={(save.isPending ? save.variables.auto_pr : me?.automations?.auto_pr) ?? true} disabled={!me} pending={save.isPending} onCheckedChange={v => save.mutate({ auto_pr: v })} /></div></Section>
    {save.isError && <p role="alert" className="text-sm text-failed">{save.error.message}</p>}
    <RunnerCreator disabled={false} />
    {runners.data?.map(r => <RunnerCard key={r.id} runner={r} disabled={false} editing={editing === r.id} onEdit={() => setEditing(editing === r.id ? null : r.id)} />)}
    {runners.isError && <p className="text-sm text-failed">Couldn't load schedules.</p>}
  </div></Shell>
}
