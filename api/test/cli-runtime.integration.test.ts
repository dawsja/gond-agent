import { command } from "../src/command";
import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/db";
import { CLIRuntimes } from "../src/cli-runtime";
import { ContainerPool } from "../src/containers";
import type { Config } from "../src/config";
test.skipIf(!process.env.GOND_AGENT_CONTAINER_TEST_IMAGE)("installs official CLI packages and starts isolated authorization",async()=>{
  const data=await mkdtemp(join(tmpdir(),"gond-cli-test-"));
  const db=openStore(data);
  const cfg:Config={data,secret:"x".repeat(32),origin:"http://localhost",signup:false,port:8787,dockerBin:"docker",workerImage:process.env.GOND_AGENT_CONTAINER_TEST_IMAGE!,maxRuns:5,runCPUs:2,runMemoryMB:2048,idleMs:60000,turnMs:60000};
  const runtimes=new CLIRuntimes(db,cfg),pool=new ContainerPool(cfg);
  try{
    for(const backend of ["codex","claude-code"] as const){
      const runtime=await runtimes.install(backend);
      const workspace=await pool.start(`run_${backend==='codex'?'a':'b'}`.padEnd(28,'0'),async()=>new Response(null,{status:403}),runtime.volume);
      try{
        await workspace.rpc("cli_prepare",{state:{},config:{backend,auth:true,effort:"default"}});
        await workspace.rpc("start",{backend,model:"",effort:"default"});
        let events:Record<string,any>[]=[],cursor=0;
        for(let n=0;n<60;n++){
          const batch=await workspace.rpc<{events:Record<string,any>[];alive:boolean}>("events",{after:cursor});cursor+=batch.events.length;events.push(...batch.events);
          if(events.some(e=>e.type==='cli.auth'&&e.url)||!batch.alive)break;
          await new Promise(r=>setTimeout(r,500));
        }
        if(!events.some(e=>e.url)){
          const containers=(await command("docker",["ps","-q","--filter",`label=io.gond-agent.run=${`run_${backend==='codex'?'a':'b'}`.padEnd(28,'0')}`])).toString().trim();
          console.error(backend,events,containers ? (await command("docker",["exec",containers,"cat","/tmp/worker.log"])).toString() : "No container");
        }
        expect(events.find(e=>e.type==='cli.auth'&&e.url)?.url).toMatch(/^https:\/\//);
        await workspace.rpc("cli_stop");
        await workspace.rpc("cli_prepare",{state:{},config:{backend,effort:"default"}});
        await workspace.rpc("start",{backend,model:"",effort:"default"});
        const discovery:Record<string,any>[]=[];
        for(let n=0;n<60;n++){
          const batch=await workspace.rpc<{events:Record<string,any>[];alive:boolean}>("events",{after:cursor});cursor+=batch.events.length;discovery.push(...batch.events);
          if(discovery.some(e=>e.type==='cli.catalog')||!batch.alive)break;
          await new Promise(r=>setTimeout(r,500));
        }
        expect(discovery.find(e=>e.type==='cli.catalog')?.models).toBeInstanceOf(Array);

      }finally{await workspace.destroy();}
      await runtimes.uninstall(backend);
    }
  }finally{
    for(const backend of ["codex","claude-code"] as const)await runtimes.uninstall(backend).catch(()=>{});
    db.close();await rm(data,{recursive:true,force:true});}
},180000);
