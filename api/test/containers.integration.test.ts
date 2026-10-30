// Real Docker + control relay + Rust worker + Chromium. Opt in locally; Docker CI always runs this.
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ContainerPool, type Workspace } from "../src/containers";
import { command } from "../src/command";
import type { Config } from "../src/config";

const image = process.env.GOND_AGENT_CONTAINER_TEST_IMAGE;
function config(data: string): Config {
  return {data, origin:"http://localhost:8787", secret:"host-only-test-secret-not-for-containers", signup:true, port:8787,
    dockerBin:process.env.DOCKER_BIN ?? "docker", workerImage:image!, maxRuns:1, runCPUs:2, runMemoryMB:2048, idleMs:60000, turnMs:60000};
}
const call = (id: string, name: string, input: unknown) => ({type:"tool_call",id,name,input});
function sse(blocks: any[]) {
  let text = "event: response.start\ndata: {\"id\":\"fixture\",\"model\":\"fixture\"}\n\n";
  blocks.forEach((b,i) => {
    text += `event: block.start\ndata: ${JSON.stringify({index:i,type:b.type,id:b.id,name:b.name})}\n\n`;
    if(b.type === "text") text += `event: block.delta\ndata: ${JSON.stringify({index:i,text:b.text})}\n\n`;
    text += `event: block.end\ndata: ${JSON.stringify({index:i,input:b.input})}\n\n`;
  });
  return text + `event: response.end\ndata: ${JSON.stringify({stop_reason:blocks.some(b=>b.type==="tool_call")?"tool_use":"end_turn",usage:{input_uncached:100,output:20,cache_read:0,cache_write:0}})}\n\n`;
}

describe.skipIf(!image)("real container workspaces", () => {
  it.skipIf(!process.env.GOND_AGENT_RUNTIME_TEST_IMAGE).each([1440, 390])("completes first-account and provider setup on HTTP at %ipx and survives restart", async (width) => {
    const dir = await mkdtemp(join(tmpdir(), "gond-agent-onboarding-"));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const project = dir.split("/").at(-1)!.toLowerCase();
    await mkdir(join(dir, "gh"));
    const env = { ...process.env, BETTER_AUTH_SECRET: "test-only-browser-setup-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://gond-agent:8787", ALLOW_SIGNUP: "false", PORT: "0", BIND_ADDRESS: "127.0.0.1",
      GH_CONFIG_PATH: join(dir, "gh"), GOND_AGENT_IMAGE: process.env.GOND_AGENT_RUNTIME_TEST_IMAGE!, GOND_AGENT_WORKER_IMAGE: image! };
    const docker = process.env.DOCKER_BIN ?? "docker";
    const compose = (...args: string[]) => command(docker, ["compose", "--project-name", project, "--env-file", "/dev/null", "-f", join(root, "docker-compose.yml"), ...args], { env, timeout: 90000 });
    const browser = async (phase: string) => {
      const script = await readFile(new URL("./onboarding.browser.cjs", import.meta.url), "utf8");
      const result = JSON.parse((await command(docker, ["run", "--rm", "--network", `${project}_default`, "--network-alias", "provider-fixture",
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--shm-size", "256m",
        "--env", `WIDTH=${width}`, "--env", `PHASE=${phase}`, "--entrypoint", "node", image!, "-e", script], { timeout: 90000 })).toString());
      const evidence = process.env.GOND_AGENT_BROWSER_ARTIFACTS ?? join(dir, "evidence");
      await mkdir(evidence, { recursive: true });
      for (const shot of result.screenshots ?? []) await writeFile(join(evidence, shot.name), Buffer.from(shot.data, "base64"));
      expect(result.error).toBeUndefined();
      expect(result.passed).toBe(true);
    };
    try {
      await compose("up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "60");
      await compose("exec", "-T", "gond-agent", "node", "-e", "if(require('node:fs').existsSync('/app/site'))process.exit(1)");
      await browser("bootstrap");
      await compose("up", "-d", "--no-build", "--pull", "never", "--force-recreate", "--wait", "--wait-timeout", "60");
      await browser("returning");
    } finally {
      await compose("down", "--volumes", "--remove-orphans");
      await rm(dir, { recursive: true, force: true });
    }
  }, 240000);

  it.skipIf(!process.env.GOND_AGENT_RUNTIME_TEST_IMAGE)("starts Compose without builds, includes both images and preserves data on repeated up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gond-agent-compose-"));
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const project = dir.split("/").at(-1)!.toLowerCase();
    const envFile = join(dir, "test.env");
    const gh = join(dir, "gh");
    await mkdir(gh);
    await writeFile(envFile, [
      "BETTER_AUTH_SECRET=test-only-compose-secret-at-least-32-characters",
      "BETTER_AUTH_URL=http://localhost:8787", "PORT=0", "BIND_ADDRESS=127.0.0.1",
      `GH_CONFIG_PATH=${gh}`,
      `DOCKER_SOCKET_PATH=${process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock"}`,
    ].join("\n"));
    const env = { ...process.env };
    delete env.GOND_AGENT_IMAGE;
    delete env.GOND_AGENT_WORKER_IMAGE;
    for (const key of ["PORT", "BIND_ADDRESS", "GH_CONFIG_PATH", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"]) delete env[key];
    const base = ["compose", "--project-name", project, "--project-directory", root, "--env-file", envFile, "-f", join(root, "docker-compose.yml")];
    const docker = process.env.DOCKER_BIN ?? "docker";
    const compose = (...args: string[]) => command(docker, [...base, ...args], { env, timeout: 90000 });
    try {
      const defaults = JSON.parse((await compose("config", "--format", "json")).toString());
      expect(Object.keys(defaults.services).sort()).toEqual(["gond-agent", "worker-image"]);
      expect(defaults.services["gond-agent"].image).toBe("ghcr.io/dawsja/gond-agent:main");
      expect(defaults.services["worker-image"].image).toBe("ghcr.io/dawsja/gond-agent-worker:main");
      for (const service of Object.values(defaults.services) as any[]) {
        expect(service.build).toBeUndefined();
        expect(service.profiles).toBeUndefined();
      }
      const build = JSON.parse((await compose("-f", join(root, "docker-compose.build.yml"), "config", "--format", "json")).toString());
      expect(build.services["gond-agent"].image).toBe("gond-agent:local");
      expect(build.services["gond-agent"].build.target).toBe("runtime");
      expect(build.services["worker-image"].build.target).toBe("worker-image");
      expect(build.services["gond-agent"].environment.GOND_AGENT_WORKER_IMAGE).toBe("gond-agent-worker:local");

      env.GOND_AGENT_IMAGE = process.env.GOND_AGENT_RUNTIME_TEST_IMAGE!;
      env.GOND_AGENT_WORKER_IMAGE = image!;
      await compose("up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "60");
      const worker = (await compose("ps", "--all", "--quiet", "worker-image")).toString().trim();
      const info = JSON.parse((await command(docker, ["inspect", worker])).toString())[0];
      expect(info.State.Status).toBe("exited");
      expect(info.State.ExitCode).toBe(0);
      expect(info.Config.Entrypoint).toEqual(["/usr/bin/true"]);
      expect(info.Mounts).toEqual([]);
      const address = (await compose("port", "gond-agent", "8787")).toString().trim();
      expect((await fetch(`http://${address}/health`)).ok).toBe(true);
      const exec = (...args: string[]) => compose("exec", "-T", "gond-agent", "node", ...args);
      await exec("-e", "require('node:fs').writeFileSync('/data/compose-check', 'preserved')");
      const before = (await exec("-e", "console.log(require('node:fs').readFileSync('/data/container-instance', 'utf8'))")).toString().trim();
      await compose("up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "60");
      expect((await exec("-e", "console.log(require('node:fs').readFileSync('/data/compose-check', 'utf8'))")).toString().trim()).toBe("preserved");
      expect((await exec("-e", "console.log(require('node:fs').readFileSync('/data/container-instance', 'utf8'))")).toString().trim()).toBe(before);
      expect((await exec("-e", "console.log(process.env.GOND_AGENT_WORKER_IMAGE)")).toString().trim()).toBe(image);
    } finally {
      // Only this uniquely named test project's disposable resources are removed.
      await compose("down", "--volumes", "--remove-orphans");
      await rm(dir, { recursive: true, force: true });
    }
  }, 180000);

  it.skipIf(!process.env.GOND_AGENT_RUNTIME_TEST_IMAGE)("launches sibling workers from the packaged service with no host networking or workspace bind paths", async () => {
    const script = `
      import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
      import {ContainerPool} from '/app/api/src/containers.ts';
      import {command} from '/app/api/src/command.ts';
      import {configFromEnv} from '/app/api/src/config.ts';
      const dir=await mkdtemp('/tmp/runtime-check-');
      const cfg={...configFromEnv(),data:dir};
      const pool=new ContainerPool(cfg);
      let workspace;
      try {
        const repo=dir+'/repo'; await mkdir(repo); await writeFile(repo+'/a.txt','hello');
        for(const args of [['init'],['add','.'],['-c','user.name=Test','-c','user.email=test@localhost','commit','-m','fixture']])await command('git',args,{cwd:repo});
        const archive=await command('tar',['-czf','-','-C',repo,'.']);
        workspace=await pool.start('run_'+'f'.repeat(24),async req=>{
          if(new URL(req.url).pathname==='/v1/models')return Response.json({models:[{id:'fixture',context_window:100000}]});
          const lines=[
            ['response.start',{id:'r',model:'fixture'}],['block.start',{index:0,type:'text'}],
            ['block.delta',{index:0,text:'Runtime relay works'}],['block.end',{index:0}],
            ['response.end',{stop_reason:'end_turn',usage:{input_uncached:10,output:10,cache_read:0,cache_write:0}}]
          ];
          return new Response(lines.map(([event,data])=>'event: '+event+'\\ndata: '+JSON.stringify(data)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
        });
        await workspace.rpc('setup',{archive:archive.toString('base64')});
        await workspace.rpc('start',{model:'fixture'});
        await workspace.rpc('send',{input:{type:'user',text:'Hello',images:[]}});
        const deadline=Date.now()+30000; let cursor=0,done=false;
        while(Date.now()<deadline){
          const batch=await workspace.rpc('events',{after:cursor}); cursor+=batch.events.length;
          if(batch.events.some(e=>e.type==='error'))throw new Error('Worker failed');
          if(batch.events.some(e=>e.type==='turn.end'&&e.stop_reason==='end_turn')){done=true;break;}
          await new Promise(r=>setTimeout(r,100));
        }
        if(!done)throw new Error('No completed worker turn');
        const snapshot=await workspace.rpc('snapshot');
        if(!snapshot.bundle||snapshot.head.length!==40)throw new Error('Git export failed');
        console.log('Packaged service launched worker, relayed model traffic and exported Git');
      }finally{await workspace?.destroy();await rm(dir,{recursive:true,force:true});}
    `;
    const output = await command(process.env.DOCKER_BIN ?? "docker",[
      "run","--rm","--network","none","--mount",`type=bind,source=${process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock"},target=/var/run/docker.sock`,
      "--env",`GOND_AGENT_WORKER_IMAGE=${image}`,"--env","BETTER_AUTH_SECRET=temporary-runtime-test-secret-only-123456789",
      "--entrypoint","node",process.env.GOND_AGENT_RUNTIME_TEST_IMAGE!,"--import","tsx","--input-type=module","-e",script,
    ],{timeout:90000});
    expect(output.toString()).toContain("Packaged service launched worker");
  },120000);

  it("runs tools, streams model replies/images, exports Git, accepts follow-ups, interrupts and cleans up", async () => {
    const dir = await mkdtemp(join(tmpdir(),"gond-agent-container-"));
    const cfg = config(dir), pool = new ContainerPool(cfg);
    let workspace: Workspace | undefined;
    const id = "run_" + "a".repeat(24);
    const requests: any[] = [];
    const workflow = [
      [call("symbols","symbols",{action:"outline",path:"app.ts"}), call("batch","batch",{calls:[{tool:"read",input:{path:"app.ts"}},{tool:"symbols",input:{action:"references",symbol:"greet"}}]})],
      [call("write","write",{path:"feature.txt",content:"verified\n"})],
      [call("serve","bash",{command:"python3 -m http.server 3000 --bind 127.0.0.1",run_in_background:true})],
      [call("check","bash",{command:"python3 -c \"import os,pathlib,time,urllib.request; time.sleep(0.3); assert os.getuid()==1000; assert pathlib.Path('feature.txt').read_text().strip()=='verified'; assert urllib.request.urlopen('http://127.0.0.1:3000').status==200\""})],
      [call("browser","browser",{url:"http://127.0.0.1:3000",script:"await page.getByRole('button', {name:'Save', exact:true}).click(); await expect(page.getByRole('button')).toHaveText('Saved');"})],
      [call("diff","bash",{command:"git diff --no-ext-diff; git ls-files --others --exclude-standard; cat feature.txt"})],
      [call("review","finish_review",{understanding:"Traced greet and save flow",design:"Follow existing flow",checks:["check"],diff_call_id:"diff",review:"Reviewed new file and both screenshots",web_app:true})],
    ];
    let n = 0;
    let interrupting = false;
    const handler = async (req: Request) => {
      if(new URL(req.url).pathname === "/v1/models") return Response.json({models:[{id:"fixture",context_window:100000}]});
      const body = await req.json(); requests.push(body);
      const blocks = interrupting ? [call("sleep","bash",{command:"sleep 30"})] : workflow[n++] ?? [{type:"text",text:"Verified and self-reviewed."}];
      const data = sse(blocks);
      // Deliberately split SSE records across HTTP chunks to exercise the relay.
      return new Response(new ReadableStream({start(controller){for(let i=0;i<data.length;i+=97)controller.enqueue(new TextEncoder().encode(data.slice(i,i+97)));controller.close();}}),{headers:{"content-type":"text/event-stream"}});
    };
    const docker = (...args: string[]) => command(cfg.dockerBin,args);
    try {
      await pool.recover();
      const repo = join(dir,"repo"); await mkdir(repo);
      await writeFile(join(repo,"index.html"),"<title>Container fixture</title><button onclick=\"this.textContent='Saved'\">Save</button>");
      await writeFile(join(repo,"app.ts"),"export function greet() { return 'hello'; }\ngreet();\n");
      for(const args of [["init"],["add","."],["-c","user.name=Test","-c","user.email=test@localhost","commit","-m","fixture"]]) await command("git",args,{cwd:repo});
      const archive = await command("tar",["-czf","-","-C",repo,"."]);
      workspace = await pool.start(id,handler);
      await expect(pool.start("run_"+"b".repeat(24),handler)).rejects.toThrow("slots");
      const container = (await docker("ps","-q","--filter",`label=io.gond-agent.run=${id}`)).toString().trim();
      const inspect = JSON.parse((await docker("inspect",container)).toString())[0];
      expect(inspect.Config.User).toBe("1000:1000");
      expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
      expect(inspect.HostConfig.Privileged).toBe(false);
      expect(inspect.HostConfig.CapDrop).toContain("ALL");
      expect(inspect.HostConfig.SecurityOpt).toContain("no-new-privileges=true");
      expect(inspect.HostConfig.PidsLimit).toBe(512);
      expect(inspect.HostConfig.Memory).toBe(2048*1024*1024);
      expect(inspect.HostConfig.PortBindings ?? {}).toEqual({});
      expect(inspect.Mounts.map((m:any)=>[m.Type,m.Destination])).toEqual([["volume","/workspace/repo"]]);
      expect(JSON.stringify(inspect.Config.Env)).not.toMatch(/host-only|BETTER_AUTH|GH_TOKEN|GITHUB_TOKEN|DOCKER_HOST/);
      await workspace.rpc("setup",{archive:archive.toString("base64")});
      await workspace.rpc("start",{model:"fixture"});
      await workspace.rpc("send",{input:{type:"user",text:"Implement and verify",images:[]}});
      let cursor = 0;
      const events: any[] = [];
      async function until(predicate: (event:any)=>boolean) {
        const deadline = Date.now()+90000;
        while(Date.now()<deadline) {
          const batch = await workspace!.rpc<{events:any[];alive:boolean}>("events",{after:cursor});
          cursor += batch.events.length; events.push(...batch.events);
          const error = batch.events.find(e=>e.type==="error");
          if(error) throw new Error(error.message);
          if(batch.events.some(predicate)) return;
          expect(batch.alive).toBe(true); await delay(100);
        }
        throw new Error("Container event stream timed out");
      }
      await until(e=>e.type==="turn.end" && e.agent_id==="main");
      expect(events.filter(e=>e.type==="tool.end" && !e.ok)).toEqual([]);
      expect(events.find(e=>e.type==="tool.images" && e.call_id==="browser").images).toHaveLength(2);
      expect(events.find(e=>e.type==="tool.end" && e.call_id==="review").ok).toBe(true);
      expect(events.find(e=>e.type==="turn.end").stop_reason).toBe("end_turn");
      expect(requests.some(req=>req.messages.some((m:any)=>m.role==="tool" && m.content.some((b:any)=>b.content?.some((p:any)=>p.type==="image"))))).toBe(true);
      const snapshot = await workspace.rpc<{bundle:string;head:string}>("snapshot",{title:"Container result"});
      const bundle = join(dir,"result.bundle"); await writeFile(bundle,Buffer.from(snapshot.bundle,"base64"));
      await command("git",["bundle","verify",bundle],{cwd:repo});
      await command("git",["fetch",bundle,"HEAD"],{cwd:repo});
      expect((await command("git",["show","FETCH_HEAD:feature.txt"],{cwd:repo})).toString()).toBe("verified\n");
      await workspace.rpc("send",{input:{type:"user",text:"Summarize the result",images:[]}});
      await until(e=>e.type==="turn.end" && e.agent_id==="main");
      expect(events.filter(e=>e.type==="session.start")).toHaveLength(1);
      interrupting = true;
      await workspace.rpc("send",{input:{type:"user",text:"Wait until interrupted",images:[]}});
      await until(e=>e.type==="tool.start" && e.call_id==="sleep");
      await workspace.rpc("send",{input:{type:"interrupt"}});
      await until(e=>e.type==="turn.end" && e.stop_reason==="interrupted");
      await workspace.destroy(); await workspace.destroy();
      expect((await docker("ps","-aq","--filter",`label=io.gond-agent.run=${id}`)).toString().trim()).toBe("");
      expect((await docker("volume","ls","-q","--filter",`label=io.gond-agent.run=${id}`)).toString().trim()).toBe("");
      expect((await docker("network","ls","-q","--filter",`label=io.gond-agent.run=${id}`)).toString().trim()).toBe("");
    } finally { await workspace?.destroy(); await rm(dir,{recursive:true,force:true}); }
  },180000);

  it("recovers only this instance's orphaned containers, volumes and networks, and cleans failed starts", async () => {
    const dir = await mkdtemp(join(tmpdir(),"gond-agent-recovery-"));
    const first = new ContainerPool(config(join(dir,"one"))), other = new ContainerPool(config(join(dir,"two")));
    const id = "run_"+"c".repeat(24), otherId="run_"+"d".repeat(24);
    const handler = async()=>Response.json({models:[]});
    let a: Workspace|undefined, b: Workspace|undefined;
    try {
      a=await first.start(id,handler); b=await other.start(otherId,handler);
      await new ContainerPool(config(join(dir,"one"))).recover();
      expect(await b.rpc("ping")).toEqual({ready:true});
      await expect(a.rpc("ping")).rejects.toThrow();
      const broken=new ContainerPool({...config(join(dir,"bad")),workerImage:"gond-agent-does-not-exist:fixture"});
      await expect(broken.start("run_"+"e".repeat(24),handler)).rejects.toThrow();
      await broken.recover();
    } finally { await a?.destroy(); await b?.destroy(); await rm(dir,{recursive:true,force:true}); }
  },120000);
});
