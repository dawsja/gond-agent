import type { Store } from "./db";
import type { Usage } from "./wire";
const fields = ["input_uncached","output","cache_read","cache_write","reasoning"] as const;
/** Persist cumulative vendor counters as deltas; replayed result events are idempotent. */
export function recordCLIUsage(db:Store,user:string,run:string,event:{id:string;model:string;usage:Usage;cumulative?:boolean;session?:string}) {
  if(typeof event.id!=="string" || event.id.length>1000 || typeof event.model!=="string" || event.model.length>240)throw new Error("Invalid CLI usage identity");
  const value=Object.fromEntries(fields.map(k=>[k,Number.isSafeInteger(event.usage?.[k])&&event.usage[k]>=0?event.usage[k]:0])) as unknown as Usage;
  return db.transaction(()=>{
    if(db.prepare("SELECT 1 FROM cli_usage WHERE event_id=? AND run_id=?").get(`${run}:${event.id}`,run))return null;
    let delta=value;
    if(event.cumulative){
      const key=`${run}:${event.session}:${event.model}`;
      const old=db.prepare("SELECT data FROM cli_usage_totals WHERE key=?").get(key) as {data:string}|undefined;
      const previous=old?JSON.parse(old.data):{};
      delta=Object.fromEntries(fields.map(k=>[k,Math.max(0,value[k]-(previous[k]??0))])) as unknown as Usage;
      const next=Object.fromEntries(fields.map(k=>[k,Math.max(value[k],previous[k]??0)]));
      db.prepare("INSERT INTO cli_usage_totals(key,run_id,data) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(key,run,JSON.stringify(next));
    }
    db.prepare("INSERT INTO cli_usage(event_id,user_id,run_id,model_id,data,created_at) VALUES(?,?,?,?,?,?)").run(`${run}:${event.id}`,user,run,event.model,JSON.stringify(delta),Date.now());
    return delta;
  })();
}
