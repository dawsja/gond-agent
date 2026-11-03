import { GondAgentMark } from "@shared/logo"

export function AgentLabel() {
  return (
    <div data-agent-label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span role="img" aria-label="Gond Agent" className="inline-flex shrink-0"><GondAgentMark size={16} /></span>
      <span>Agent</span>
    </div>
  )
}
