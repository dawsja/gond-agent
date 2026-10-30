import { randomBytes } from "node:crypto";
import { seal, unseal } from "./auth";
import type { Store } from "./db";
import type { Workspace, WorkspaceFactory } from "./containers";
import { CLIRuntimes, type CLI } from "./cli-runtime";
import { ApiError } from "./wire";
export interface CLIModel { id: string; name: string; efforts: string[] }
export interface CLIState { credentials: Record<string,string>; files: Record<string,string>; session?: string }
interface Flow { owner: string; session: string; workspace: Workspace; state: Record<string,unknown>; cursor: number; expires: number; closed: boolean }
export class CLIAccounts {
  private flows = new Map<string,Flow>();
  private catalogs = new Map<string,{checked:number;pending?:Promise<void>}>();
  private probes = new Map<string,Workspace>();
  constructor(private db: Store, private secret: string, private factory: WorkspaceFactory, private runtimes: CLIRuntimes) {}
  account(user: string, backend: CLI) {
    return this.db.prepare("SELECT credentials,models,connected_at FROM cli_accounts WHERE user_id=? AND backend=?").get(user,backend) as {credentials:string;models:string;connected_at:number}|undefined;
  }
  credentials(user: string, backend: CLI) {
    const account = this.account(user,backend);
    if (!account) throw new ApiError(409,"cli_signin","Sign into this subscription in Settings first.");
    return JSON.parse(unseal(this.secret,account.credentials)) as Record<string,string>;
  }
  models(user: string) {
    return (this.db.prepare("SELECT backend,models FROM cli_accounts WHERE user_id=?").all(user) as {backend:CLI;models:string}[]).filter(r=>this.runtimes.get(r.backend)).flatMap(r=>(JSON.parse(r.models) as CLIModel[]).map(m=>({...m,backend:r.backend})));
  }
  status(user:string, session:string) {
    return (["claude-code","codex"] as CLI[]).map(backend=>({backend, installed:!!this.runtimes.get(backend), connected:!!this.account(user,backend), connectedAt:this.account(user,backend)?.connected_at, modelCount:JSON.parse(this.account(user,backend)?.models ?? "[]").length, flow:this.flows.get(`${user}:${backend}`)?.session===session?this.flows.get(`${user}:${backend}`)?.state:undefined}));
  }
  async start(user:string, session:string, backend:CLI, authorized:()=>Promise<boolean> = async()=>true) {
    const key=`${user}:${backend}`;
    await this.cancel(user,session,backend);
    const runtime=this.runtimes.get(backend);
    if(!runtime)throw new ApiError(409,"cli_install","An administrator needs to install this runtime first.");
    const workspace=await this.factory(`run_${randomBytes(12).toString("hex")}`,async()=>new Response(null,{status:403}),runtime.volume);
    const flow:Flow={owner:user,session,workspace,state:{status:"starting"},cursor:0,expires:Date.now()+600000,closed:false};
    this.flows.set(key,flow);
    try {
      await workspace.rpc("cli_prepare",{state:{},config:{backend,auth:true,effort:"default"}});
      await workspace.rpc("start",{backend,model:"",effort:"default"});
      void this.poll(key,backend,flow,authorized);
      return flow.state;
    }catch{await this.dispose(flow);throw new ApiError(502,"cli_login","Couldn't start sign-in. Check the runtime installation.");}
  }
  async code(user:string,session:string,backend:CLI,code:unknown) {
    const flow=this.flows.get(`${user}:${backend}`);
    if(!flow || flow.session!==session || flow.closed)throw new ApiError(409,"cli_flow","Start a new sign-in in this session.");
    if(typeof code!=="string" || !code.trim() || code.length>4096 || /[\r\n]/.test(code))throw new ApiError(400,"cli_code","Enter the authorization code.");
    await flow.workspace.rpc("send",{input:{code:code.trim()}});
    return {ok:true};
  }
  private async dispose(flow:Flow){flow.closed=true;await flow.workspace.destroy();}
  async cancel(user:string,session:string,backend:CLI){
    const key=`${user}:${backend}`,flow=this.flows.get(key);
    if(flow && !flow.closed){if(flow.session!==session)throw new ApiError(409,"cli_flow","This sign-in belongs to another session.");await this.dispose(flow);}
    this.flows.delete(key);
  }
  private async poll(key:string,backend:CLI,flow:Flow,authorized:()=>Promise<boolean>){
    try {
      while(!flow.closed){
        if(Date.now()>flow.expires){flow.state={status:"expired"};break;}
        const batch=await flow.workspace.rpc<{events:Record<string,any>[];alive:boolean}>("events",{after:flow.cursor});
        flow.cursor+=batch.events.length;
        for(const e of batch.events){
          if(e.type==="cli.auth"){
            flow.state={...flow.state,...e};
            if(e.status==="connected"){
              const state=await flow.workspace.rpc<CLIState>("cli_state");
              if(!await authorized() || flow.closed || Date.now()>flow.expires){flow.state={status:"cancelled"};return;}
              if(!this.db.prepare('SELECT 1 FROM "user" WHERE id=?').get(flow.owner))break;
              this.db.prepare("INSERT INTO cli_accounts(user_id,backend,credentials,connected_at) VALUES(?,?,?,?) ON CONFLICT(user_id,backend) DO UPDATE SET credentials=excluded.credentials,models='[]',connected_at=excluded.connected_at").run(flow.owner,backend,seal(this.secret,JSON.stringify(state.credentials)),Date.now());
              // Discover through a fresh official CLI session, without sending an inference prompt.
              await this.dispose(flow);
              const runtime=this.runtimes.get(backend)!;
              const probe=await this.factory(`run_${randomBytes(12).toString("hex")}`,async()=>new Response(null,{status:403}),runtime.volume);
              flow.workspace=probe;
              flow.closed=false;
              try{
                await probe.rpc("cli_prepare",{state,config:{backend,effort:"default"}});
                await probe.rpc("start",{backend,model:"",effort:"default"});
                let cursor=0;
                for(let n=0;n<60;n++){
                  const b=await probe.rpc<{events:Record<string,any>[];alive:boolean}>("events",{after:cursor});cursor+=b.events.length;
                  const catalog=b.events.find(e=>e.type==="cli.catalog");
                  if(catalog && !flow.closed && this.flows.get(key)===flow){
                    const refreshed=await probe.rpc<CLIState>("cli_state");
                    if(flow.closed || this.flows.get(key)!==flow)break;
                    this.db.prepare("UPDATE cli_accounts SET models=?,credentials=? WHERE user_id=? AND backend=?").run(JSON.stringify(catalog.models),seal(this.secret,JSON.stringify(refreshed.credentials)),flow.owner,backend);break;
                  }
                  if(!b.alive || b.events.some(e=>e.type==='error'))break;
                  await new Promise(r=>setTimeout(r,500));
                }
              }finally{await this.dispose(flow);}
              return;
            }
            if(e.status==="error")return;
          }
        }
        if(!batch.alive){flow.state={status:"error"};break;}
        await new Promise(r=>setTimeout(r,500));
      }
    }catch{flow.state={status:"error",message:"Sign-in didn't finish. Try again."};}
    finally{await this.dispose(flow).catch(()=>{});}
  }
  busy(user:string,backend:CLI){const key=`${user}:${backend}`;return !!this.catalogs.get(key)?.pending || !!this.flows.get(key)&&!this.flows.get(key)!.closed;}
  async refresh(user:string,backend:CLI,force=false){
    const key=`${user}:${backend}`,old=this.account(user,backend),runtime=this.runtimes.get(backend);
    if(!old||!runtime||this.flows.get(key)&&!this.flows.get(key)!.closed)return;
    if(this.db.prepare("SELECT 1 FROM runs WHERE user_id=? AND json_extract(data,'$.backend')=? AND status IN ('queued','working') AND deleted_at IS NULL LIMIT 1").get(user,backend))return;
    const cached=this.catalogs.get(key);
    if(cached?.pending)return cached.pending;
    if(cached&&Date.now()-cached.checked<(force?5000:60000))return;
    const entry:{checked:number;pending?:Promise<void>}={checked:Date.now()};this.catalogs.set(key,entry);
    entry.pending=(async()=>{
      let workspace:Workspace|undefined;
      try{
        workspace=await this.factory(`run_${randomBytes(12).toString("hex")}`,async()=>new Response(null,{status:403}),runtime.volume);
        this.probes.set(key,workspace);
        if(this.account(user,backend)?.connected_at!==old.connected_at)return;
        await workspace.rpc("cli_prepare",{state:{credentials:JSON.parse(unseal(this.secret,old.credentials))},config:{backend,effort:"default"}});
        await workspace.rpc("start",{backend,model:"",effort:"default"});
        let cursor=0;
        for(let n=0;n<60;n++){
          const batch=await workspace.rpc<{events:Record<string,any>[];alive:boolean}>("events",{after:cursor});cursor+=batch.events.length;
          const catalog=batch.events.find(e=>e.type==='cli.catalog');
          if(catalog){
            const refreshed=await workspace.rpc<CLIState>("cli_state");
            const current=this.account(user,backend);
            if(current?.credentials!==old.credentials||current.connected_at!==old.connected_at)return;
            this.db.prepare("UPDATE cli_accounts SET models=?,credentials=? WHERE user_id=? AND backend=?").run(JSON.stringify(catalog.models),seal(this.secret,JSON.stringify(refreshed.credentials)),user,backend);
            return;
          }
          if(!batch.alive||batch.events.some(e=>e.type==='error'))return;
          await new Promise(r=>setTimeout(r,500));
        }
      }catch{ /* A failed refresh retains this account's previous catalog. */ }
      finally{this.probes.delete(key);await workspace?.destroy().catch(()=>{});entry.pending=undefined;}
    })();
    return entry.pending;
  }
  async logout(user:string,backend:CLI){
    await this.probes.get(`${user}:${backend}`)?.destroy();this.probes.delete(`${user}:${backend}`);this.catalogs.delete(`${user}:${backend}`);
    for(const [key,flow] of this.flows)if(flow.owner===user&&key.endsWith(`:${backend}`)){await this.dispose(flow);this.flows.delete(key);}
    this.db.prepare("DELETE FROM cli_accounts WHERE user_id=? AND backend=?").run(user,backend);
  }
  async remove(user:string){for(const backend of ["claude-code","codex"] as CLI[])await this.logout(user,backend);}
  async close(){await Promise.all([...this.probes.values()].map(w=>w.destroy().catch(()=>{})));await Promise.all([...this.flows.values()].map(f=>this.dispose(f).catch(()=>{})));}
}
