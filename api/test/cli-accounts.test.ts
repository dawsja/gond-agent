import { it,expect } from "vitest";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore,setSetting } from "../src/db";
import { CLIAccounts } from "../src/cli-accounts";
import { CLIRuntimes } from "../src/cli-runtime";
import type { Config } from "../src/config";
it("subscription flows belong to their account and initiating session; credentials stay encrypted",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"gond-cli-account-")),db=openStore(dir),secret="s".repeat(32);
 db.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES (\'a\'),(\'b\');');
 setSetting(db,"runtime:codex",{backend:"codex",volume:"test",version:"0.166.0"});
 let destroyed=0;
 const accounts=new CLIAccounts(db,secret,async()=>({rpc:async(method:string)=>{
   if(method==='events')return {alive:true,events:[{type:'cli.auth',status:'pending',url:'https://auth.openai.com/codex/device',code:'ABCD'}]} as any;
   return true as any;
 },destroy:async()=>{destroyed++;}}),new CLIRuntimes(db,{} as Config));
 try{
   await accounts.start('a','session-a','codex');
   await new Promise(r=>setTimeout(r,10));
   expect(accounts.status('a','session-a')[1].flow?.code).toBe('ABCD');
   expect(accounts.status('a','different-session')[1].flow).toBeUndefined();
   expect(accounts.status('b','session-a')[1].flow).toBeUndefined();
   await expect(accounts.code('b','session-a','codex','x')).rejects.toThrow(/new sign-in/);
   await expect(accounts.cancel('a','different-session','codex')).rejects.toThrow(/another session/);
   expect(()=>accounts.credentials('b','codex')).toThrow(/Sign into/);
   await accounts.cancel('a','session-a','codex');
   expect(destroyed).toBeGreaterThan(0);
 }finally{await accounts.close();db.close();await rm(dir,{recursive:true,force:true});}
});
it("does not save approved credentials after the initiating session is revoked",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"gond-cli-revoked-")),db=openStore(dir),secret="s".repeat(32);
 db.exec('CREATE TABLE "user" (id TEXT PRIMARY KEY); INSERT INTO "user" VALUES (\'a\');');
 setSetting(db,"runtime:codex",{backend:"codex",volume:"test",version:"0.166.0"});
 const accounts=new CLIAccounts(db,secret,async()=>({rpc:async(method:string)=>{
   if(method==='events')return {alive:true,events:[{type:'cli.auth',status:'connected'}]} as any;
   if(method==='cli_state')return {credentials:{'.codex/auth.json':'fixture-credential'},files:{}} as any;
   return true as any;
 },destroy:async()=>{}}),new CLIRuntimes(db,{} as Config));
 try{
   await accounts.start('a','revoked','codex',async()=>false);
   await new Promise(r=>setTimeout(r,20));
   expect(accounts.account('a','codex')).toBeUndefined();
   expect(accounts.status('a','revoked')[1].flow?.status).toBe('cancelled');
 }finally{await accounts.close();db.close();await rm(dir,{recursive:true,force:true});}
});
