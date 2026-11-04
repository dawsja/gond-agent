import type { Run } from "@/lib/api"

export function QueueReason({ run }: { run: Run }) {
  return <div className="mt-1 text-[13px] text-muted-foreground">
    {run.queue_reason && <p>{run.queue_reason}</p>}
    {(run.capacity?.idle_releasable ?? 0) > 0 && <p>Use Close workspace on an idle run to free a slot, or leave it to close automatically for waiting work.</p>}
  </div>
}
