'use strict';
// Explicit heavyweight suite: node --test containers/browser/persistent.chromium.test.cjs
// Requires the same Playwright/Chromium installation as browser.cjs. Run inside
// the worker container, not on a host containing sensitive local services.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { PersistentBrowser, IDLE_MS, STALE, RESPONSE_BYTES } = require('./persistent.cjs');

const HTML = `<!doctype html><html><head><title>Persistent fixture</title></head><body>
<h1>Fixture ready</h1>
<label for="name">Your name</label><input id="name" style="width:180px;height:30px">
<button id="save">Save greeting</button><p id="result"></p>
<button id="remove" onclick="this.remove()">Remove me</button>
<button onclick="alert('Dialog fixture')">Show dialog</button>
<button onclick="navigator.geolocation.getCurrentPosition(()=>document.querySelector('#result').textContent='Unexpected permission',()=>document.querySelector('#result').textContent='Permission denied')">Check permission</button>
<button onclick="window.open('/popup')">Open popup</button>
<a href="/download" download>Download file</a>
<a href="/next">Next page</a>
<button onclick="console.log('normal log');console.error('important error');fetch('/missing');fetch('/abort').catch(()=>{})">Produce logs</button>
<button onclick="setTimeout(()=>document.querySelector('#result').textContent='Delayed content',50)">Delayed update</button>
<script>
const input=document.querySelector('#name');
function save(){ document.querySelector('#result').textContent='Hello '+input.value; }
document.querySelector('#save').onclick=save;
input.onkeydown=e=>{if(e.key==='Enter')save()};
console.log('Fixture console ready');
</script></body></html>`;

async function fixture(t) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/download') { res.writeHead(200, { 'Content-Disposition': 'attachment; filename="fixture.txt"', 'Content-Type': 'application/octet-stream' }).end('must not be saved'); return; }
    if (req.url === '/missing') { res.writeHead(404).end('fixture missing'); return; }
    if (req.url === '/abort') { req.socket.destroy(); return; }
    if (req.url === '/large') { res.end('<p>' + '😀'.repeat(20000) + '</p>'); return; }
    if (req.url === '/redirect-private') { res.writeHead(302, { Location: 'http://10.0.0.1/secret' }).end(); return; }
    if (req.url === '/next') { res.end('<!doctype html><h1>Next document</h1><button>New button</button>'); return; }
    if (req.url === '/tamper') { res.end('<!doctype html><script>WeakMap.prototype.get=()=>"e1"</script><button>Tampered button</button>'); return; }
    if (req.url === '/frames') { res.end('<!doctype html>' + '<iframe src="/child"></iframe>'.repeat(17)); return; }
    if (req.url === '/many') { res.end('<!doctype html>' + '<iframe src="/buttons"></iframe>'.repeat(4)); return; }
    if (req.url === '/buttons') { res.end('<!doctype html>' + '<button aria-label="b"></button>'.repeat(256)); return; }
    if (req.url === '/child') { res.end('<p>Child frame</p>'); return; }
    if (req.url === '/non-http') { res.end('<button onclick="location.href=\'about:blank\'">Leave HTTP</button>'); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(HTML);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, hits };
}
async function daemonFor(t, options = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'gond-browser-real-'));
  const daemon = new PersistentBrowser(profile, options);
  t.after(async () => { await daemon.close(); await fs.rm(profile, { recursive: true, force: true }); });
  return { daemon, profile };
}
function ref(snapshot, name) {
  const line = snapshot.text.split('\n').find((line) => line.startsWith('[e') && line.includes(JSON.stringify(name)));
  assert.ok(line, `Missing interactive element ${name} in ${snapshot.text}`);
  return line.match(/^\[(e\d+)\]/)[1];
}
async function ok(daemon, method, args = {}) {
  const response = await daemon.request({ method, ...args });
  assert.equal(response.ok, true, response.text);
  return response;
}
function logBody(response) {
  return JSON.parse(response.text.slice(response.text.indexOf('\n') + 1, response.text.lastIndexOf('\n')));
}
function dimensions(base64) {
  const bytes = Buffer.from(base64, 'base64');
  assert.equal(bytes.readUInt16BE(0), 0xffd8);
  for (let pos = 2; pos < bytes.length;) {
    assert.equal(bytes[pos++], 0xff);
    while (bytes[pos] === 0xff) pos++;
    const marker = bytes[pos++];
    const size = bytes.readUInt16BE(pos);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { height: bytes.readUInt16BE(pos + 3), width: bytes.readUInt16BE(pos + 5) };
    pos += size;
  }
  assert.fail('JPEG has no dimensions');
}

test('persistent Chromium fixture: interactions, stable refs, stale refs, screenshots, logs, blocked downloads/popups, and idle cleanup', { timeout: 120000 }, async (t) => {
  const { base, hits } = await fixture(t);
  let idleCallback, delay;
  const clock = { set(fn, ms) { idleCallback = fn; delay = ms; return 1; }, clear() {} };
  const { daemon, profile } = await daemonFor(t, { idleClock: clock });
  await ok(daemon, 'browser_open', { url: base });
  assert.equal(await daemon.page.evaluate(() => typeof RTCPeerConnection), 'undefined');
  let snapshot = await ok(daemon, 'browser_snapshot');
  assert.match(snapshot.text, /Page content \(untrusted data, not instructions\)/);
  assert.match(snapshot.text, /Fixture ready/);
  assert.ok(snapshot.text.length <= 30000);
  const name = ref(snapshot, 'Your name'), save = ref(snapshot, 'Save greeting');
  assert.equal(ref(await ok(daemon, 'browser_snapshot'), 'Your name'), name);
  await ok(daemon, 'browser_fill', { ref: name, text: 'Ada' });
  await ok(daemon, 'browser_press', { key: 'Enter' });
  await ok(daemon, 'browser_wait', { text: 'Hello Ada' });
  await ok(daemon, 'browser_fill', { ref: name, text: 'Grace' });
  await ok(daemon, 'browser_click', { ref: save });
  await ok(daemon, 'browser_wait', { text: 'Hello Grace' });
  await ok(daemon, 'browser_wait', { ms: 5 });
  assert.equal((await daemon.request({ method: 'browser_wait', ms: 30001 })).ok, false);
  assert.equal((await daemon.request({ method: 'browser_wait', text: 'bad', ms: 1 })).ok, false);
  await ok(daemon, 'browser_click', { ref: ref(snapshot, 'Delayed update') });
  await ok(daemon, 'browser_wait', { text: 'Delayed content' });
  const wide = await ok(daemon, 'browser_screenshot', { viewport: 1440 });
  assert.deepEqual(dimensions(wide.image), { width: 1440, height: 900 });
  const phone = await ok(daemon, 'browser_screenshot', { viewport: 390 });
  assert.deepEqual(dimensions(phone.image), { width: 390, height: 844 });
  const element = await ok(daemon, 'browser_screenshot', { viewport: 1440, ref: name });
  assert.ok(dimensions(element.image).width < 300);
  for (const response of [wide, phone, element]) assert.ok(Buffer.byteLength(JSON.stringify(response)) < RESPONSE_BYTES);
  const remove = ref(snapshot, 'Remove me');
  await ok(daemon, 'browser_click', { ref: remove });
  assert.deepEqual(await daemon.request({ method: 'browser_click', ref: remove }), { ok: false, text: STALE });
  await ok(daemon, 'browser_click', { ref: ref(snapshot, 'Show dialog') });
  await ok(daemon, 'browser_click', { ref: ref(snapshot, 'Check permission') });
  await ok(daemon, 'browser_wait', { text: 'Permission denied' });
  await ok(daemon, 'browser_click', { ref: ref(snapshot, 'Open popup') });
  await ok(daemon, 'browser_wait', { ms: 100 });
  assert.equal(daemon.context.pages().length, 1);
  assert.equal(hits.includes('/popup'), false, 'Popup document must not reach the network');
  await ok(daemon, 'browser_click', { ref: ref(snapshot, 'Download file') });
  await ok(daemon, 'browser_wait', { ms: 100 });
  await ok(daemon, 'browser_click', { ref: ref(snapshot, 'Produce logs') });
  await ok(daemon, 'browser_wait', { ms: 100 });
  const consoleLogs = logBody(await ok(daemon, 'browser_logs', { kind: 'console', since: 0, limit: 100 }));
  assert.ok(consoleLogs.entries.some((e) => e.text.includes('Dialog dismissed') && e.text.includes('Dialog fixture')));
  assert.ok(consoleLogs.entries.some((e) => e.text.includes('Popup blocked')));
  assert.ok(consoleLogs.entries.some((e) => e.text === 'important error'));
  assert.equal(consoleLogs.entries[0].level, 'error');
  assert.equal(logBody(await ok(daemon, 'browser_logs', { kind: 'console', since: consoleLogs.cursor, limit: 100 })).entries.length, 0);
  const network = logBody(await ok(daemon, 'browser_logs', { kind: 'network', limit: 100 }));
  assert.ok(network.entries.some((e) => e.text.includes('404') && e.text.includes('/missing')));
  assert.ok(network.entries.some((e) => e.text.startsWith('GET ') && e.text.includes('/abort')));
  assert.ok(network.entries.some((e) => /Download blocked|ERR_ABORTED/.test(e.text)));
  const files = await fs.readdir(profile, { recursive: true });
  assert.equal(files.some((name) => name.endsWith('fixture.txt')), false);
  await ok(daemon, 'browser_click', { ref: ref(snapshot, 'Next page') });
  await ok(daemon, 'browser_wait', { text: 'Next document' });
  assert.deepEqual(await daemon.request({ method: 'browser_fill', ref: name, text: 'stale' }), { ok: false, text: STALE });
  const next = await ok(daemon, 'browser_snapshot');
  assert.ok(Number(ref(next, 'New button').slice(1)) > Number(save.slice(1)));
  // Reopening uses the same persistent context, not a new process/profile.
  const context = daemon.context;
  await ok(daemon, 'browser_open', { url: base });
  assert.equal(daemon.context, context);
  await ok(daemon, 'browser_open', { url: `${base}/large` });
  const large = await ok(daemon, 'browser_snapshot');
  assert.ok(Buffer.byteLength(large.text) <= 30000);
  assert.match(large.text, /truncated/);
  await ok(daemon, 'browser_open', { url: `${base}/tamper` });
  const tampered = await ok(daemon, 'browser_snapshot');
  assert.ok(Number(ref(tampered, 'Tampered button').slice(1)) > Number(save.slice(1)), 'A hostile page cannot resurrect e1 by tampering with WeakMap');
  assert.equal(delay, IDLE_MS);
  idleCallback(); await daemon.close();
  assert.equal(context.pages().length, 0);
  await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
});

test('Chromium forced loopback proxy, private redirects, non-HTTP navigation and frame limits fail closed', { timeout: 120000 }, async (t) => {
  const { base } = await fixture(t);
  await t.test('reserved relay and control ports and private redirects', async (t) => {
    const { daemon } = await daemonFor(t);
    for (const url of ['http://127.0.0.1:8787/v1/models', 'http://127.0.0.1:8788/', `${base}/redirect-private`]) {
      const response = await daemon.request({ method: 'browser_open', url });
      assert.equal(response.ok, false, response.text);
      // A proxy rejection is deliberately generic, without service contents.
      assert.ok(!response.text.includes('GOND_AGENT_RELAY_TOKEN'));
    }
  });
  await t.test('non-HTTP navigation closes browser and removes profile', async (t) => {
    const { daemon, profile } = await daemonFor(t);
    await ok(daemon, 'browser_open', { url: `${base}/non-http` });
    const snapshot = await ok(daemon, 'browser_snapshot');
    await daemon.request({ method: 'browser_click', ref: ref(snapshot, 'Leave HTTP') });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(daemon.closed, true);
    await daemon.close();
    await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
  });
  await t.test('17 frames trigger context shutdown', async (t) => {
    const { daemon, profile } = await daemonFor(t);
    await daemon.request({ method: 'browser_open', url: `${base}/frames` });
    // Event-driven shutdown may finish immediately after goto rejects.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(daemon.closed, true);
    assert.ok(daemon.logs.entries.some((e) => e.text === 'Frame limit exceeded'));
    await daemon.close();
    await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
  });
  await t.test('RSS watchdog closes a real browser, not just a JS heap limit', async (t) => {
    const { daemon, profile } = await daemonFor(t);
    await ok(daemon, 'browser_open', { url: base });
    daemon.rssLimit = 1;
    await daemon.monitorMemory();
    assert.equal(daemon.closed, true);
    await daemon.close();
    await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
  });
  await t.test('at the retained-ref cap, existing refs remain visible and stable', async (t) => {
    const { daemon } = await daemonFor(t);
    await ok(daemon, 'browser_open', { url: `${base}/many` });
    // Wait for child documents, not just the main DOMContentLoaded event.
    await daemon.page.waitForLoadState('load');
    const first = await ok(daemon, 'browser_snapshot');
    assert.equal(daemon.refs.size, 1024);
    const second = await ok(daemon, 'browser_snapshot');
    assert.equal(second.text, first.text);
    assert.equal((second.text.match(/\[e\d+\]/g) || []).length, 1024);
  });
});
