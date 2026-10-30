// Official native agents, adapted to Gond's worker event protocol.
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(readFileSync('/tmp/cli-config.json', 'utf8'));
const emit = (type, value = {}) => process.stdout.write(JSON.stringify({ type, agent_id: 'main', ...value }) + '\n');
const backend = config.backend;
const requireRuntime = createRequire('/opt/gond-runtime/package/package.json');
const env = { ...process.env, HOME: '/tmp/cli-home', CODEX_HOME: '/tmp/cli-home/.codex', CLAUDE_CONFIG_DIR: '/tmp/cli-home/.claude' };
for (const key of Object.keys(env)) if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_|AWS_|GOOGLE_)/.test(key)) delete env[key];
mkdirSync(env.CODEX_HOME,{recursive:true,mode:0o700});
mkdirSync(env.CLAUDE_CONFIG_DIR,{recursive:true,mode:0o700});
env.DISABLE_AUTOUPDATER='1';
env.CLAUDE_CODE_FORWARD_SUBAGENT_TEXT='1';
const sdkRoot = '/opt/gond-runtime/package/node_modules/@anthropic-ai';
function claudeBinary() {
  const folder = readdirSync(sdkRoot).find(n => n === `claude-agent-sdk-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
  if (!folder) throw new Error('This runtime has no compatible native Claude binary');
  return `${sdkRoot}/${folder}/claude`;
}
const instructions = `You are working in Gond Agent's isolated coding workspace. Read and follow AGENTS.md and GOND_AGENT.md. Before ending every coding turn use Gond MCP bash tools to run relevant verification and inspect the final git diff and new files, then call Gond finish_review with successful call IDs. Web applications require the Gond browser tool's wide and phone screenshot tests. Inspect returned screenshots. Completion without current verification and self-review is blocked. Do not claim human approval. Do not push or create pull requests; Gond handles Git publication.`;
let session = config.session;
let agent;
let child;
let busy = false;
let interrupted = false;

const inputs = [];
let wake;
async function* messages() {
  while (true) {
    if (!inputs.length) await new Promise(resolve => { wake = resolve; });
    while (inputs.length) yield inputs.shift();
  }
}
function enqueue(message) { inputs.push(message); wake?.(); wake = undefined; }
function saveSession() { writeFileSync('/tmp/cli-session.json', JSON.stringify({ session })); }
function usage(model, u, id) { emit('cli.usage', { id, model, usage: u, session, cumulative:backend==='claude-code' }); }
function review() {
  try { execFileSync('/usr/local/bin/gond-agent-worker', ['--check-review'], { env, stdio: 'pipe' }); return true; }
  catch { return false; }
}
const subagents=new Set();
let corrections = 0;
async function ended(ok, interrupted = false) {
  saveSession();
  if (ok && !interrupted && !review()) {
    if (corrections++ < 2) return send({ type: 'user', text: 'Completion is blocked. Run verification and inspect the final diff with Gond MCP tools, inspect wide/phone browser screenshots for web apps, then call finish_review with the current evidence call IDs.', correction: true });
    emit('error', { message: 'Verification and self-review are incomplete. Changes have not been published.' });
    busy = false;
    return;
  }
  busy = false;
  emit('turn.end', { stop_reason: interrupted ? 'interrupted' : ok ? 'end_turn' : 'error' });
}
async function setupClaude() {
  const sdk = await import(pathToFileURL(requireRuntime.resolve('@anthropic-ai/claude-agent-sdk')).href);
  agent = sdk.query({ prompt: messages(), options: {
    pathToClaudeCodeExecutable: claudeBinary(), env, cwd: process.cwd(),
    ...(config.model ? {model:config.model} : {}), ...(config.effort !== 'default' ? { effort: config.effort } : {}),
    resume: session, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    includePartialMessages: true, systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions },
    settingSources: ['project'], mcpServers: { gond: { command: '/usr/local/bin/gond-agent-worker', args: ['--tool-server'] } },
  }});
  const pump = (async () => {
    for await (const m of agent) {
      if (m.session_id) { session = m.session_id; saveSession(); }
      if (m.type === 'stream_event') {
        const e = m.event;
        if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') emit('text.delta', { text: e.delta.text });
        if (e.type === 'content_block_delta' && e.delta.type === 'thinking_delta') emit('reasoning.delta', { text: e.delta.thinking });
      }
      if (m.type === 'assistant') for (const b of m.message.content ?? []) {
        const agent_id=m.parent_tool_use_id ?? 'main';
        if(m.parent_tool_use_id && b.type==='text')emit('text.delta',{agent_id,text:b.text});
        if (b.type === 'tool_use') {
          emit('tool.start', { agent_id,call_id: b.id, name: b.name, title: b.name, input: b.input });
          if(['Agent','Task'].includes(b.name)){subagents.add(b.id);emit('agent.spawn',{agent_id:b.id,parent_id:agent_id,kind:b.input.subagent_type ?? 'agent',description:b.input.description ?? 'Subagent'});}
        }
      }
      if (m.type === 'user' && Array.isArray(m.message?.content)) for (const b of m.message.content) {
        if(subagents.has(b.tool_use_id)){emit('agent.end',{agent_id:b.tool_use_id,ok:!b.is_error,summary:'Subagent finished'});subagents.delete(b.tool_use_id);}
        if (b.type === 'tool_result') emit('tool.end', { call_id: b.tool_use_id, ok: !b.is_error, summary: '', output: (typeof b.content === 'string' ? b.content : JSON.stringify(b.content.filter(c=>c.type==='text'))).slice(0,64000) });
      }
      if (m.type === 'rate_limit_event') emit('cli.limits', { limits: m.rate_limit_info });
      if (m.type === 'result') {
        for (const [model, u] of Object.entries(m.modelUsage ?? {})) usage(model, { input_uncached: u.inputTokens, output: u.outputTokens, cache_read: u.cacheReadInputTokens, cache_write: u.cacheCreationInputTokens, reasoning: u.thinkingTokens ?? 0 }, `${session}:${m.uuid}:${model}`);
        if (m.is_error && !interrupted) emit('error', { message: 'Claude Code could not finish this turn. Check your sign-in and subscription limits.' });
        await ended(!m.is_error, interrupted);interrupted=false;
      }
    }
  })();
  pump.catch(fail);
  const models = await agent.supportedModels();
  emit('cli.catalog', { models: models.map(m => ({ id: m.value, name: m.displayName, efforts: m.supportedEffortLevels ?? [] })) });
  emit('cli.account', { account: await agent.accountInfo() });
}
let serial = 0;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Agent request timed out')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
async function setupCodex() {
  child = spawn('/opt/gond-runtime/package/node_modules/.bin/codex', ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers.gond.command="/usr/local/bin/gond-agent-worker"', '-c', 'mcp_servers.gond.args=["--tool-server"]', '-c', 'cli_auth_credentials_store="file"'], { env, stdio: ['pipe','pipe','pipe'] });
  child.stderr.resume();
  child.on('error', fail);
  child.on('exit', () => { for (const p of pending.values()) {clearTimeout(p.timer);p.reject(new Error('Codex exited'));} pending.clear(); });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined && !m.method) {
        const p = pending.get(m.id); if (!p) return;
        pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error('Codex request failed')); else p.resolve(m.result);
        return;
      }
      const p = m.params ?? {};
      if (m.method === 'account/login/completed') emit('cli.auth', { status: p.success ? 'connected' : 'error' });
      if (m.method === 'account/rateLimits/updated') emit('cli.limits', { limits: p });
      if (m.method === 'item/agentMessage/delta') emit('text.delta', { agent_id:p.threadId && p.threadId!==session ? p.threadId : 'main',text: p.delta });
      if (m.method === 'item/reasoning/summaryTextDelta') emit('reasoning.delta', { text: p.delta });
      if (m.method === 'item/started' && ['commandExecution','fileChange','mcpToolCall'].includes(p.item?.type)) emit('tool.start', {call_id:p.item.id,name:p.item.type,title:p.item.command ?? p.item.tool ?? p.item.type,input:p.item});
      if (m.method === 'item/completed' && ['commandExecution','fileChange','mcpToolCall'].includes(p.item?.type)) emit('tool.end', {call_id:p.item.id,ok:p.item.status==='completed',summary:p.item.status,output:p.item.aggregatedOutput ?? JSON.stringify(p.item.result ?? '')});
      if (m.method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage.last;
        if (u) usage(config.model, { input_uncached: Math.max(0,u.inputTokens-u.cachedInputTokens), output:u.outputTokens, cache_read:u.cachedInputTokens,cache_write:0,reasoning:u.reasoningOutputTokens }, `${session}:${p.turnId}:${p.tokenUsage.total.totalTokens}`);
      }
      if (m.method === 'turn/completed') void ended(p.turn.status === 'completed', p.turn.status === 'interrupted').catch(fail);
      if (m.id !== undefined && m.method) child.stdin.write(JSON.stringify({id:m.id,error:{code:-32601,message:'This request is unavailable in autonomous mode'}})+'\n');
    } catch { fail(); }
  });
  await rpc('initialize', { clientInfo: { name:'gond_agent', title:'Gond Agent', version:'1' }, capabilities:{} });
  child.stdin.write(JSON.stringify({ method:'initialized' })+'\n');
  if (config.auth) {
    const login = await rpc('account/login/start', { type:'chatgptDeviceCode' });
    emit('cli.auth', {status:'pending',url:login.verificationUrl,code:login.userCode,loginId:login.loginId});
    return;
  }
  const models = [];
  let cursor;
  do { const r = await rpc('model/list', {limit:100,...(cursor ? {cursor} : {})}); models.push(...r.data); cursor=r.nextCursor; } while(cursor && models.length<500);
  emit('cli.catalog',{models:models.map(m=>({id:m.model,name:m.displayName,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort)}))});
  emit('cli.account', {account:await rpc('account/read')});
  const r = await rpc(session ? 'thread/resume':'thread/start', { ...(session ? {threadId:session} : {}), model:config.model, cwd:process.cwd(), approvalPolicy:'never', sandbox:'danger-full-access', developerInstructions:instructions });
  session=r.thread.id;saveSession();
  rpc('account/rateLimits/read').then(limits=>emit('cli.limits',{limits})).catch(()=>{});
}
async function send(m) {
  if (m.type === 'interrupt') { interrupted=true; if (backend==='codex') await rpc('turn/interrupt',{threadId:session,turnId:currentTurn}); else await agent.interrupt(); return; }
  if (m.type !== 'user') return;
  if (!m.correction) { interrupted=false;corrections=0; emit('turn.start'); writeFileSync('/tmp/gond-turn',randomUUID()); try {unlinkSync('/tmp/gond-reviewed');} catch {} }
  busy=true;
  const effort=m.effort ?? config.effort;
  if (backend==='codex') {
    const input=[{type:'text',text:m.text}];
    for (const image of m.images ?? []) if(image.data) input.push({type:'image',url:`data:${image.media_type};base64,${image.data}`});
    const r=await rpc('turn/start',{threadId:session,input,model:config.model,...(effort!=='default'?{effort}: {})}); currentTurn=r.turn.id;
  } else {
    if (effort !== 'default') await agent.applyFlagSettings({effortLevel:effort});
    else await agent.applyFlagSettings({effortLevel:null});
    const content=[{type:'text',text:m.text},...(m.images??[]).filter(i=>i.data).map(i=>({type:'image',source:{type:'base64',media_type:i.media_type,data:i.data}}))];
    enqueue({type:'user',message:{role:'user',content},parent_tool_use_id:null,session_id:session??''});
  }
}
let currentTurn;
function fail() {emit('error',{message:'The coding agent stopped unexpectedly. Check its installation, sign-in, and subscription limits.'});busy=false;}
if(config.auth && backend==='claude-code') {
  child=spawn(claudeBinary(),['auth','login','--claudeai'],{env,stdio:['pipe','pipe','pipe']});
  let size=0;
  const output=b=>{size+=b.length;if(size>65536){child.kill();return;} const text=b.toString().replace(/\x1b\[[0-9;]*m/g,'');const url=text.match(/https:\/\/[^\s\x1b]+/);if(url)emit('cli.auth',{status:'pending',url:url[0]});if(/paste.*code/i.test(text))emit('cli.auth',{status:'pending',needsCode:true});};
  child.stdout.on('data',output);child.stderr.on('data',output);child.on('error',fail);child.on('exit',code=>emit('cli.auth',{status:code===0?'connected':'error'}));
  createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(typeof m.code==='string')child.stdin.write(m.code+'\n');});
} else {
  const waiting=[];let initialized=false;
  createInterface({input:process.stdin}).on('line',line=>{try{const m=JSON.parse(line);if(initialized)send(m).catch(fail);else waiting.push(m);}catch{fail();}});
  try {await (backend==='codex'?setupCodex():setupClaude());initialized=true;for(const m of waiting)await send(m);}catch{fail();}
}
