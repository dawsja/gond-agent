import { it,expect } from "vitest";
import { openStore } from "../src/db";
import { recordCLIUsage } from "../src/cli-usage";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
it("accounts for cumulative session totals once across follow-ups and replay",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"gond-cli-usage-")),db=openStore(dir);
 try{
  db.prepare("INSERT INTO runs(id,user_id,repo,status,created_at,updated_at,data) VALUES('r','u','a/b','working',0,0,'{}')").run();
  const event={id:'1',session:'s',model:'m',cumulative:true,usage:{input_uncached:100,output:30,cache_read:20,cache_write:5,reasoning:10}};
  expect(recordCLIUsage(db,'u','r',event)?.output).toBe(30);
  expect(recordCLIUsage(db,'u','r',event)).toBeNull();
  const next={...event,id:'2',usage:{...event.usage,input_uncached:150,output:50,reasoning:15}};
  expect(recordCLIUsage(db,'u','r',next)).toEqual({input_uncached:50,output:20,cache_read:0,cache_write:0,reasoning:5});
  expect(recordCLIUsage(db,'u','r',{...event,id:'old'})?.output).toBe(0);
  expect((db.prepare("SELECT sum(json_extract(data,'$.output')) n FROM cli_usage").get() as {n:number}).n).toBe(50);
 }finally{db.close();await rm(dir,{recursive:true,force:true});}
});
