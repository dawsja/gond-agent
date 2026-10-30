import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, type Me } from "@/lib/api"
import { useMe, useRunners } from "@/lib/queries"
import { Section } from "../studio/section"
import { Shell } from "../studio/shell"
import { Switch } from "../studio/switch"
import { RunnerCard, RunnerCreator } from "./runners"
export function AutomationsScreen() {
  const [editing, setEditing] = useState<string | null>(null)
  const { data: me } = useMe(), runners = useRunners(), qc = useQueryClient()
  const save = useMutation({ mutationFn: (body: Partial<NonNullable<Me["automations"]>>) => api("/v1/me/automations", { method: "PUT", body }), onSuccess: () => void qc.invalidateQueries({ queryKey: ["me"] }) })
  return <Shell active="Automations" crumbs={<span>Automations</span>} contentClassName="overflow-y-auto"><div className="mx-auto w-full max-w-[900px] space-y-5 px-5 py-10"><h1 className="text-3xl font-semibold">Automations</h1>
    <Section title="Pull requests" description="Choose whether a finished run opens a pull request automatically."><div className="flex items-center justify-between border-t border-border p-5 text-sm"><span>Open pull requests automatically</span><Switch checked={me?.automations?.auto_pr ?? true} onChange={v => save.mutate({ auto_pr: v })} label="Automatic pull requests" /></div></Section>
    {save.isError && <p role="alert" className="text-sm text-failed">{save.error.message}</p>}
    <RunnerCreator disabled={false} />
    {runners.data?.map(r => <RunnerCard key={r.id} runner={r} disabled={false} editing={editing === r.id} onEdit={() => setEditing(editing === r.id ? null : r.id)} />)}
    {runners.isError && <p className="text-sm text-failed">Couldn't load schedules.</p>}
  </div></Shell>
}
