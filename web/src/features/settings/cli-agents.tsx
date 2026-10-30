import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { useMe } from "@/lib/queries"
import { Button } from "@shared/ui/button"
import { Input } from "@shared/ui/input"
import { Field, FieldLabel } from "@shared/ui/field"
import { Section } from "../studio/section"
type Backend = "claude-code" | "codex"
interface Account { backend: Backend; installed: boolean; connected: boolean; modelCount?:number; limits?: {status?:string;utilization?:number;resetsAt?:number;rateLimits?:{primary?:{usedPercent:number;resetsAt:number};secondary?:{usedPercent:number;resetsAt:number}}}; limitsUpdatedAt?:number; flow?: {status:string;url?:string;code?:string;needsCode?:boolean;message?:string} }
interface Runtime { backend: Backend; availableVersion?:string; runtime?: {version:string}; operation?: {status:string;message?:string} }
export function CLIAgents() {
  const me=useMe(), qc=useQueryClient()
  const [codes,setCodes]=useState<Record<string,string>>({})
  const accounts=useQuery({queryKey:["cli-accounts"],queryFn:()=>api<{accounts:Account[]}>("/v1/cli/accounts"),refetchInterval:2000})
  const connected=accounts.data?.accounts.filter(a=>a.connected && a.modelCount).map(a=>a.backend).join(",")
  useEffect(()=>{void qc.invalidateQueries({queryKey:["models"]});void qc.invalidateQueries({queryKey:["me"]})},[connected,qc])
  const runtimes=useQuery({queryKey:["cli-runtimes"],queryFn:()=>api<{runtimes:Runtime[]}>("/v1/cli/runtimes"),refetchInterval:5000})
  const action=useMutation({mutationFn:({path,method,body}:{path:string;method:string;body?:unknown})=>api(path,{method,body}),onSettled:()=>{void qc.invalidateQueries({queryKey:["cli-accounts"]});void qc.invalidateQueries({queryKey:["cli-runtimes"]});void qc.invalidateQueries({queryKey:["models"]});void qc.invalidateQueries({queryKey:["me"]})}})
  return <Section title="Subscription agents" description="Use your own Claude or ChatGPT subscription. An administrator installs the coding agent on this server; each account signs in separately.">
    {(["claude-code","codex"] as Backend[]).map(backend=>{
      const account=accounts.data?.accounts.find(a=>a.backend===backend), runtime=runtimes.data?.runtimes.find(r=>r.backend===backend)
      const flow=account?.flow, pending=flow && ["starting","pending"].includes(flow.status)
      const name=backend==="codex"?"Codex":"Claude Code"
      return <div key={backend} className="flex flex-col gap-3 border-t border-border p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-sm font-medium">{name}</p><p className="text-xs text-muted-foreground">{runtime?.runtime?`Installed ${runtime.runtime.version} · Supported ${runtime.availableVersion ?? runtime.runtime.version}`:"Not installed"} · {account?.connected?"Signed in with your account":"Signed out"}</p></div>
        {me.data?.admin && <div className="flex gap-2"><Button variant="outline" size="sm" disabled={action.isPending} onClick={()=>action.mutate({path:`/v1/cli/runtimes/${backend}`,method:"POST"})}>{runtime?.runtime?"Update":"Install"}</Button>{runtime?.runtime&&<Button variant="ghost" size="sm" disabled={action.isPending} onClick={()=>action.mutate({path:`/v1/cli/runtimes/${backend}`,method:"DELETE"})}>Uninstall</Button>}</div>}</div>
        {runtime?.operation?.status==="working"&&<p role="status" className="text-sm">Installing…</p>}
        {runtime?.operation?.message&&<p role="alert" className="text-sm text-failed">{runtime.operation.message}</p>}
        {account?.connected&&<p className="text-xs text-muted-foreground">{account.limits?.rateLimits?.primary ? `${account.limits.rateLimits.primary.usedPercent}% of the current allowance used; resets ${new Date(account.limits.rateLimits.primary.resetsAt*1000).toLocaleString()}` : account.limits?.utilization !== undefined ? `${Math.round(account.limits.utilization*100)}% allowance used` : account.limits?.status ? `Allowance: ${account.limits.status}` : "Allowance information is unavailable until the agent reports it."}{account.limitsUpdatedAt?` · Updated ${new Date(account.limitsUpdatedAt).toLocaleString()}`:""}</p>}
        {account?.installed&&<div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" disabled={action.isPending} onClick={()=>action.mutate({path:me.data?.admin?`/v1/cli/runtimes/${backend}/close`:`/v1/cli/accounts/${backend}/close`,method:"POST"})}>Close idle workspaces</Button><Button variant="outline" size="sm" disabled={action.isPending||!!pending} onClick={()=>action.mutate({path:`/v1/cli/accounts/${backend}/login`,method:"POST"})}>{account.connected?"Reconnect":"Sign in"}</Button>{pending&&<Button variant="ghost" size="sm" onClick={()=>action.mutate({path:`/v1/cli/accounts/${backend}/login`,method:"DELETE"})}>Cancel</Button>}{account.connected&&<Button variant="ghost" size="sm" disabled={action.isPending} onClick={()=>action.mutate({path:`/v1/cli/accounts/${backend}`,method:"DELETE"})}>Sign out</Button>}</div>}
        {pending&&<div className="flex flex-col gap-2">{flow.url&&<Button asChild variant="link" className="self-start"><a href={flow.url} target="_blank" rel="noreferrer">Continue on {backend==="codex"?"OpenAI":"Claude"}</a></Button>}{flow.code&&<p className="font-mono text-sm">{flow.code}</p>}{flow.needsCode&&<Field><FieldLabel>Authorization code<Input value={codes[backend]??""} autoComplete="off" onChange={e=>setCodes({...codes,[backend]:e.target.value})}/></FieldLabel><Button variant="outline" size="sm" disabled={action.isPending||!codes[backend]} onClick={()=>{action.mutate({path:`/v1/cli/accounts/${backend}/code`,method:"POST",body:{code:codes[backend]}});setCodes({...codes,[backend]:""})}}>Complete sign-in</Button></Field>}</div>}
        {flow&&["error","expired"].includes(flow.status)&&<p role="alert" className="text-sm text-failed">{flow.message??"Sign-in did not finish. Start a new sign-in."}</p>}
      </div>
    })}
    {(action.error??accounts.error??runtimes.error)&&<p role="alert" className="p-5 text-sm text-failed">{(action.error??accounts.error??runtimes.error)?.message}</p>}
    <p className="border-t border-border p-5 text-xs text-muted-foreground">Subscription limits and model access apply. Subscription agents use their native tools and sessions. Token usage is recorded by Gond; allowance information appears when supplied by the coding agent.</p>
  </Section>
}
