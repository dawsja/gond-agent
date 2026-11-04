// Build first: npm run build. Production run route + real event folding, mocked HTTP/WS only.
// NODE_PATH=/opt/gond-agent-browser/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/gond-agent-browser/browsers node --test test/timeline.browser.cjs
// TIMELINE_DIST=/tmp/gond-timeline-main TIMELINE_BEFORE=1 reuses the identical fixture on a saved main build.
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile, mkdir } = require('node:fs/promises');
const { resolve, extname } = require('node:path');
const { chromium, expect } = require('@playwright/test');
let server, browser, origin;
const baseline = process.env.TIMELINE_BEFORE === '1';
const root = resolve(process.env.TIMELINE_DIST || resolve(__dirname, '../dist'));
const screenshots = '/tmp/gond-timeline';
const user = { id: 'fixture', name: 'Daws', email: 'fixture@example.test' };
const now = Date.now();
const run = { id: 'timeline', user_id: user.id, repo: 'acme/app', base_branch: 'main', branch: 'timeline', model_id: 'fixture:coder', title: 'Run activity timeline', prompt: 'Review, edit and check the run timeline.', status: 'working', step: null, plan_done: 0, plan_total: 0, files: 3, additions: 94, deletions: 10, pr_number: null, pr_url: null, pr_state: null, error: null, created_at: now, started_at: now, updated_at: now, finished_at: null, live: { phase: 'agent' } };

function fixture() {
  const events = [];
  const send = (type, fields) => events.push({ type, ...fields, agent_id: 'main', seq: events.length + 1, ts: now });
  const step = (id, name, input, extra = {}) => {
    send('tool.start', { call_id: id, name, input });
    send('tool.end', { call_id: id, ok: true, ...extra });
  };
  send('run.status', { status: 'working' });
  send('user', { text: run.prompt });
  for (const [i, command] of ['npm test', 'git status --short', 'git diff --stat'].entries()) step(`command-${i}`, i === 0 ? 'Bash' : 'bash', { command });
  for (const [i, path] of ['api/src/runs/service.ts', 'web/src/features/run/transcript.ts', 'web/test/timeline.test.mjs'].entries()) {
    const add = i === 0 ? 92 : 1, del = i === 0 ? 8 : 1;
    const diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${del} +1,${add} @@\n${'-old\n'.repeat(del)}${'+new\n'.repeat(add)}`;
    step(`edit-${i}`, 'Edit', { file_path: path }, { diff });
  }
  step('command-3', 'commandExecution', { command: 'git status --short' });
  step('command-4', 'bash', { command: 'git diff --check' }, { ok: false, output: 'Trailing whitespace in service.ts' });
  for (const [i, path] of ['api/src/runs/service.ts', 'web/src/features/run/transcript.ts', 'web/src/features/run/tool-presentation.ts', 'web/test/timeline.test.mjs'].entries()) step(`read-${i}`, i === 0 ? 'Read' : 'mcp__gond__read', { path });
  step('context', 'batch', {});
  step('checks', 'run_checks', { command: 'npm run typecheck' }, { summary: '1.2s', output: 'No type errors.' });
  step('last', 'bash', { command: 'pwd' });
  send('tool.start', { call_id: 'live', name: 'bash', input: { command: 'npm run build' } });
  return { events, send };
}

before(async () => {
  await mkdir(screenshots, { recursive: true });
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    const relative = path.startsWith('/agents/assets/') ? path.slice('/agents/'.length) : 'index.html';
    try {
      const body = await readFile(resolve(root, relative));
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }[extname(relative)] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`built timeline ${baseline ? 'before' : 'after'} ${width} ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1100 }, colorScheme: theme, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const { events } = fixture();
    let socket;
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      const responses = {
        '/api/auth/get-session': { session: { id: 'fixture-session', userId: user.id, expiresAt: '2099-01-01T00:00:00Z' }, user },
        '/api/v1/me': { user, theme, accent: 'blue', setup_required: false, admin: false, automations: { auto_pr: false } },
        '/api/v1/runs': { runs: [run] },
        '/api/v1/runs/timeline': run,
        '/api/v1/runs/timeline/ticket': { ticket: 'fixture' },
        '/api/v1/runs/timeline/diff': '',
        '/api/v1/models': { models: [{ id: 'fixture:coder', provider: 'openai', display_name: 'Fixture coder', context_window: 128000 }], connections: [] },
        '/api/v1/github': { configured: false, login: null, managed: false },
        '/api/v1/github/repos': { repos: [] },
        '/api/v1/subscriptions': { providers: [], accounts: [], pending: null, welcome: false },
      };
      assert.ok(path in responses, `Unexpected request: ${path}`);
      return route.fulfill(path.endsWith('/diff') ? { body: '' } : { json: responses[path] });
    });
    await page.routeWebSocket('**/ws/runs/timeline*', ws => {
      socket = ws;
      for (const event of events) ws.send(JSON.stringify(event));
    });
    try {
      await page.goto(`${origin}/agents/runs/timeline`);
      await expect(page.getByRole('button', { name: 'Running build', exact: true })).toBeVisible();
      const hideDetails = page.getByRole('button', { name: 'Hide details', exact: true });
      if (width === 1440 && await hideDetails.isVisible()) await hideDetails.click();
      const content = page.locator('[data-run-content]');
      await content.evaluate(el => el.parentElement.scrollTop = 0);
      await page.screenshot({ path: `${screenshots}/${baseline ? 'before' : 'after'}-${width}-${theme}.png` });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
      assert.ok(await content.evaluate(el => el.scrollWidth <= el.clientWidth), 'no transcript overflow');
      if (!baseline) {
        const command = page.getByRole('button', { name: 'Ran 3 commands npm test', exact: true });
        await expect(command).toHaveAttribute('aria-expanded', 'false');
        const failure = page.getByRole('button', { name: 'Ran 2 commands · 1 failed git diff --check', exact: true });
        await expect(failure).toHaveAttribute('aria-expanded', 'false');
        await expect(failure.locator('[data-slot=trace-line]')).toHaveAttribute('data-status', 'error');
        await expect(page.getByRole('button', { name: /Edited 3 files.*api\/src\/runs\/service.ts.*\+94.*−10/ })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Explored 4 files api/src/runs/service.ts', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Checks finished · exit 0 npm run typecheck', exact: true })).toBeVisible();
        await command.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        await expect(command).toBeFocused();
        assert.notEqual(await command.evaluate(el => getComputedStyle(el).boxShadow), 'none', 'focus ring');
        await page.keyboard.press('Enter');
        await expect(command).toHaveAttribute('aria-expanded', 'true');
        const controls = await command.getAttribute('aria-controls');
        assert.ok(controls);
        await expect(page.locator(`[id="${controls}"]`)).toBeVisible();
        await expect(page.getByText('git diff --stat', { exact: true })).toBeVisible();
        await page.screenshot({ path: `${screenshots}/expanded-${width}-${theme}.png` });
        await page.keyboard.press('Space');
        await expect(command).toHaveAttribute('aria-expanded', 'false');
        await failure.click();
        await expect(page.getByText('Trailing whitespace in service.ts', { exact: true })).toBeVisible();
        await failure.click();
        const tail = page.getByRole('button', { name: 'Ran 1 command pwd', exact: true });
        await tail.click();
        const tailId = await tail.getAttribute('aria-controls');
        socket.send(JSON.stringify({ type: 'tool.end', call_id: 'live', ok: true, seq: events.length + 1, ts: now + 1000 }));
        const grown = page.getByRole('button', { name: 'Ran 2 commands pwd', exact: true });
        await expect(grown).toHaveAttribute('aria-expanded', 'true');
        await expect(grown).toHaveAttribute('aria-controls', tailId);
        await expect(page.getByText('npm run build', { exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Running build', exact: true })).toHaveCount(0);
        assert.ok(await content.evaluate(el => el.scrollWidth <= el.clientWidth), 'no expanded overflow');
        let seq = events.length + 1;
        const append = (type, fields) => socket.send(JSON.stringify({ type, ...fields, seq: ++seq, ts: now + seq }));
        append('tool.start', { call_id: 'parallel-a', name: 'read', input: { path: 'a.ts' } });
        append('tool.start', { call_id: 'parallel-b', name: 'read', input: { path: 'b.ts' } });
        append('tool.end', { call_id: 'parallel-b', ok: true });
        const laterRead = page.getByRole('button', { name: 'Explored 1 file b.ts', exact: true });
        await laterRead.click();
        await expect(laterRead).toHaveAttribute('aria-expanded', 'true');
        append('tool.end', { call_id: 'parallel-a', ok: true });
        const mergedReads = page.getByRole('button', { name: 'Explored 2 files a.ts', exact: true });
        await expect(mergedReads).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByText('b.ts', { exact: true })).toBeVisible();
        await mergedReads.click();
        append('tool.start', { call_id: 'parallel-c', name: 'read', input: { path: 'c.ts' } });
        append('tool.end', { call_id: 'parallel-c', ok: true });
        await expect(page.getByRole('button', { name: 'Explored 3 files a.ts', exact: true })).toHaveAttribute('aria-expanded', 'false');
        append('tool.start', { call_id: 'failed-check', name: 'run_checks', input: { command: 'npm test' } });
        append('tool.end', { call_id: 'failed-check', ok: false, summary: 'exit 1 · 0.2s', output: '1 test failed' });
        const failedCheck = page.getByRole('button', { name: 'Checks failed · exit 1 npm test', exact: true });
        await expect(failedCheck.locator('[data-slot=trace-line]')).toHaveAttribute('data-status', 'error');
        append('tool.start', { call_id: 'open-live', name: 'bash', input: { command: 'echo complete' } });
        const openLive = page.getByRole('button', { name: 'Running command', exact: true });
        await openLive.click();
        await expect(openLive).toHaveAttribute('aria-expanded', 'true');
        append('tool.end', { call_id: 'open-live', ok: true, output: 'Completion output stays visible' });
        await expect(page.getByRole('button', { name: 'Ran 1 command echo complete', exact: true })).toHaveAttribute('aria-expanded', 'true');
        await expect(page.getByText('Completion output stays visible', { exact: true })).toBeVisible();
        append('text.delta', { text: 'Check display safety without changing raw details.' });
        const unsafeCommand = 'printf \u202E\u200Bsafe';
        append('tool.start', { call_id: 'unsafe-command', name: 'bash', input: { command: unsafeCommand } });
        append('tool.end', { call_id: 'unsafe-command', ok: true });
        const safeCommand = page.getByRole('button', { name: 'Ran 1 command printf safe', exact: true });
        await expect(safeCommand).toHaveAttribute('aria-expanded', 'false');
        await safeCommand.click();
        const rawCommand = page.locator(`[id="${await safeCommand.getAttribute('aria-controls')}"] code`);
        assert.equal(await rawCommand.textContent(), unsafeCommand, 'expanded command stays raw');
        append('tool.start', { call_id: 'trivial-check', name: 'run_checks', input: { command: 'true\u202E\u200B' } });
        append('tool.end', { call_id: 'trivial-check', ok: true, summary: '0.0s' });
        const trivialCheck = page.getByRole('button', { name: 'Checks finished · exit 0 true', exact: true });
        await expect(trivialCheck).toHaveAttribute('aria-expanded', 'false');
        await trivialCheck.click();
        const rawCheck = page.locator(`[id="${await trivialCheck.getAttribute('aria-controls')}"] code`);
        assert.equal(await rawCheck.textContent(), 'true\u202E\u200B', 'expanded check command stays raw');
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
