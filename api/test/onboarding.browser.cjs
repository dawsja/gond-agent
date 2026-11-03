// Runs inside the worker image against the real packaged service, never API/browser mocks.
const { chromium, expect } = require('@playwright/test');
const { createServer } = require('node:http');
const { writeFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const width = Number(process.env.WIDTH);
const origin = process.env.GOND_AGENT_BROWSER_ORIGIN || 'http://gond-agent:8787';
const providerOrigin = process.env.GOND_AGENT_PROVIDER_FIXTURE_URL || 'http://provider-fixture:3030';
const fixtureDir = process.env.GOND_AGENT_GH_FIXTURE_DIR || '/fixture';
const screenshots = [];
const key = 'fixture-only-provider-key';

(async () => {
  const provider = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const second = url.pathname.startsWith('/second/');
    const authenticated = second ? req.headers.authorization === `Bearer ${key}-second` : width === 1440 ? req.headers['x-api-key'] === key && req.headers['anthropic-version'] === '2023-06-01' : req.headers.authorization === `Bearer ${key}`;
    if (!authenticated) { res.writeHead(403).end(); return; }
    if (url.pathname === '/unsupported/v1/models') { res.writeHead(404).end(); return; }
    if (!['/v1/models', '/second/v1/models'].includes(url.pathname)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fixture-model', display_name: 'Fixture coder', max_input_tokens: 200000, max_tokens: 16000, capabilities: { image_input: { supported: true } } }, { id: 'other-model', display_name: 'Other coder' }], has_more: false }));
  });
  // The replacement browser container uses the same alias/port after service restart.
  await new Promise(resolve => provider.listen(3030, '0.0.0.0', resolve));
  const browser = await chromium.launch({ executablePath: process.env.GOND_AGENT_BROWSER_EXECUTABLE, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const capture = async (name, target = page) => screenshots.push({ name: `${name}-${width}.png`, data: (await target.screenshot({ fullPage: true, mask: [target.getByLabel('New MCP token', { exact: true })] })).toString('base64') });
  const settingsURL = origin + '/api/v1/settings/providers';
  const save = async button => {
    const response = page.waitForResponse(r => r.url() === settingsURL && r.request().method() === 'PUT');
    await page.getByRole('button', { name: button, exact: true }).click();
    return response;
  };
  const advanced = async (scope, open) => {
    const details = scope.locator('details').first();
    if (await details.evaluate(element => element.open) !== open) await details.locator('summary').click();
  };
  const nameConnection = async (scope, name) => {
    await advanced(scope, true);
    await scope.getByLabel('Connection name', { exact: true }).fill(name);
    await advanced(scope, false);
  };
  const editURL = async scope => {
    await scope.getByRole('button', { name: 'Edit URL', exact: true }).click();
  };
  const selectFormat = async (scope, format) => {
    await scope.getByRole('radio', { name: format === 'anthropic' ? 'Anthropic' : 'OpenAI', exact: true }).click();
    if (format !== 'anthropic') {
      await advanced(scope, true);
      await scope.getByLabel('OpenAI API protocol', { exact: true }).selectOption(format);
      await advanced(scope, false);
    }
  };
  // UI fixtures exercise API and subscription choices without a paid model call.
  // Registration, provider setup, storage and the rest of onboarding use the real service.
  const verifyComposers = async () => {
    const efforts = ['low', 'medium', 'high'];
    const models = [
      { id: 'fixture:gpt-5.4', display_name: 'GPT-5.4 · API', provider: 'openai', efforts },
      { id: 'fixture:claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6 · API', resolved_model: 'claude-sonnet-4-6', provider: 'anthropic', efforts },
      { id: 'chatgpt.fixture:gpt-5.4', display_name: 'GPT-5.4 · ChatGPT', provider: 'openai', access: 'chatgpt', connection_id: 'chatgpt.fixture', efforts },
      { id: 'chatgpt.fixture:gpt-5.4-mini', display_name: 'GPT-5.4 mini · ChatGPT', provider: 'openai', access: 'chatgpt', connection_id: 'chatgpt.fixture', efforts },
    ].map(model => ({ context_window: 200000, backend: 'builtin', access: 'api', connection_id: model.provider, ...model }));
    const connections = [
      { id: 'openai', name: 'Provider 1', status: 'error', message: 'OpenAI API connection unavailable.' },
      { id: 'anthropic', name: 'Other API', status: 'error', message: 'Anthropic API connection unavailable.' },
      { id: 'chatgpt.fixture', name: 'ChatGPT · fixture@example.test', access: 'chatgpt', status: 'ready', usage_url: 'https://chatgpt.com/settings/usage' },
    ];
    const catalogURL = origin + '/api/v1/models';
    const fixtureRunURL = origin + '/api/v1/runs/composer-fixture';
    let current = models[0], sent, imageRequests = 0, activePreview = false, prState = null;
    const sockets = [];
    const run = () => ({ id: 'composer-fixture', user_id: 'fixture', repo: 'acme/app', base_branch: 'main', branch: 'fixture', model_id: current.id, backend: current.backend, effort: 'medium', title: 'Composer preview', prompt: 'Review the settings', status: activePreview ? 'working' : prState === 'merged' ? 'merged' : 'ready', pr_state: prState, pr_number: prState ? 42 : null, pr_url: prState ? 'https://github.com/acme/app/pull/42' : null, files: 0, additions: 0, deletions: 0, created_at: Date.now(), updated_at: Date.now(), live: { phase: 'idle' } });
    const modelRoute = route => route.fulfill({ json: { models, connections } });
    const runRoute = route => route.fulfill({ json: run() });
    const listRoute = route => route.fulfill({ json: { runs: prState ? [run()] : [] } });
    const messagesRoute = route => { sent = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }); };
    const ticketRoute = route => route.fulfill({ json: { ticket: 'composer-fixture' } });
    const diffRoute = route => route.fulfill({ body: '' });
    const imageRoute = route => { imageRequests++; return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64') }); };
    await page.route(catalogURL, modelRoute);
    await page.route(fixtureRunURL, runRoute);
    await page.route(origin + '/api/v1/runs?limit=100', listRoute);
    await page.route(fixtureRunURL + '/messages', messagesRoute);
    await page.route(fixtureRunURL + '/ticket', ticketRoute);
    await page.route(fixtureRunURL + '/diff', diffRoute);
    await page.route(fixtureRunURL + '/images/stream-image', imageRoute);
    await page.routeWebSocket('**/ws/runs/composer-fixture?*', socket => { sockets.push(socket); socket.onMessage(() => {}); });
    const layout = async label => {
      const image = await page.getByRole('button', { name: 'Attach images', exact: true }).boundingBox();
      const model = await page.getByRole('button', { name: label, exact: true }).boundingBox();
      const thinking = await page.getByRole('button', { name: 'Reasoning effort', exact: true }).boundingBox();
      expect(model.height).toBe(32); expect(thinking.height).toBe(model.height);
      expect(Math.abs(thinking.y - model.y)).toBeLessThan(1);
      expect(image.x + image.width).toBeLessThanOrEqual(model.x);
      expect(model.x + model.width).toBeLessThanOrEqual(thinking.x);
      expect(thinking.x + thinking.width).toBeLessThanOrEqual(width);
    };
    try {
      await page.goto(origin + '/agents/');
      await page.getByRole('button', { name: 'Choose model', exact: true }).click();
      for (const model of models) {
        await expect(page.getByRole('button', { name: model.display_name, exact: true }).locator('[data-model-provider]')).toHaveAttribute('data-model-provider', model.provider);
      }
      await capture('model-menu-brands');
      await page.keyboard.press('Escape');
      for (const model of models) {
        await page.getByRole('button', { name: 'Choose model', exact: true }).click();
        await page.getByRole('button', { name: model.display_name, exact: true }).click();
        await expect(page.getByRole('button', { name: 'Choose model', exact: true }).locator('[data-model-provider]')).toHaveAttribute('data-model-provider', model.provider);
        if (model.resolved_model) await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toHaveAttribute('title', model.resolved_model);
        const version = model.display_name.match(/\d+(?:\.\d+)*/)?.[0];
        if (version) expect(await page.getByRole('button', { name: 'Choose model', exact: true }).locator(':scope > span.truncate').evaluate((element, version) => {
          const start = element.textContent.indexOf(version);
          const range = document.createRange();
          range.setStart(element.firstChild, start); range.setEnd(element.firstChild, start + version.length);
          return range.getBoundingClientRect().right <= element.getBoundingClientRect().right + 1;
        }, version)).toBe(true);
        for (const connection of connections) {
          await expect(page.getByText(`${connection.name}: ${connection.message}`, { exact: true })).toHaveCount(model.access === 'api' && model.connection_id === connection.id ? 1 : 0);
        }
        await expect(page.getByText('Using ChatGPT plan', { exact: true })).toHaveCount(model.access === 'chatgpt' ? 1 : 0);
        await layout('Choose model');
        await page.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Search thinking levels', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'High', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Reasoning effort', exact: true })).toHaveText('High');
      }
      await page.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
      await capture('thinking-menu');
      await page.keyboard.press('Escape');
      await capture('subscription-no-api-warning');
      for (const model of models) {
        current = model;
        await page.goto(origin + '/agents/runs/composer-fixture');
        const picker = page.getByRole('button', { name: 'Follow-up model', exact: true });
        await expect(picker).toContainText(model.display_name.replace(/^Claude /, ''));
        await expect(picker.locator('[data-model-provider]')).toHaveAttribute('data-model-provider', model.provider);
        await layout('Follow-up model');
        await picker.click();
        for (const other of models) {
          await expect(page.getByRole('button', { name: other.display_name, exact: true })).toBeVisible();
        }
        const nextModel = models[(models.indexOf(model) + 1) % models.length];
        await page.getByRole('button', { name: nextModel.display_name, exact: true }).click();
        await page.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
        await page.getByRole('button', { name: 'Low', exact: true }).click();
        await page.getByRole('textbox', { name: 'Follow-up message', exact: true }).fill('Check the settings layout');
        const response = page.waitForResponse(fixtureRunURL + '/messages');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await response;
        expect(sent.effort).toBe('low');
        expect(sent.model).toBe(nextModel.id);
        await capture('follow-up-' + model.id.replaceAll(/[^a-zA-Z0-9-]/g, '-'));
      }
      // Exercise live folding, reconnect replay and object URL lifetime through SPA navigation.
      await page.evaluate(() => {
        const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
        window.imageURLs = { created: [], revoked: [] };
        URL.createObjectURL = blob => { const url = create(blob); window.imageURLs.created.push(url); return url; };
        URL.revokeObjectURL = url => { window.imageURLs.revoked.push(url); revoke(url); };
      });
      await expect.poll(() => sockets.length).toBe(models.length);
      const message = { seq: 1, ts: Date.now(), type: 'user', text: 'Fix sign-in on mobile. It sends me back to the login screen.', images: [{ id: 'stream-image' }] };
      sockets.at(-1).send(JSON.stringify(message));
      const attachedImage = page.getByRole('img', { name: 'Attached image', exact: true });
      await expect(attachedImage).toBeVisible();
      await expect.poll(() => attachedImage.evaluate(img => img.naturalWidth)).toBe(1);
      const imageURL = await attachedImage.getAttribute('src');
      sockets.at(-1).send(JSON.stringify({ seq: 2, ts: Date.now(), type: 'text.delta', text: 'Checking' }));
      await expect(page.getByText('Checking', { exact: true })).toBeVisible();
      sockets.at(-1).send(JSON.stringify({ seq: 3, ts: Date.now(), type: 'text.delta', text: ' now' }));
      sockets.at(-1).send(JSON.stringify({ seq: 2, ts: Date.now(), type: 'text.delta', text: 'Checking' }));
      await expect(page.getByText('Checking now', { exact: true })).toBeVisible();
      await capture('streamed-transcript-image');
      if (width !== 1440) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).click();
      await expect.poll(() => page.evaluate(url => window.imageURLs.revoked.includes(url), imageURL)).toBe(true);
      await page.goBack();
      await expect.poll(() => sockets.length).toBe(models.length + 1);
      sockets.at(-1).send(JSON.stringify(message));
      await expect(attachedImage).toBeVisible();
      expect(await attachedImage.getAttribute('src')).not.toBe(imageURL);
      expect(imageRequests).toBe(1); // Remount reuses bytes, never a revoked URL.

      // Approved A layout: real streamed messages, quiet disclosures and visible failures.
      let activitySeq = 1;
      const activity = (type, fields) => sockets.at(-1).send(JSON.stringify({ seq: ++activitySeq, ts: Date.now(), type, ...fields }));
      activePreview = true;
      activity('run.status', { status: 'working' });
      activity('text.delta', { text: "I'm checking how sign-in chooses where to send you back." });
      for (const [index, file] of ['api/src/auth.ts', 'web/src/auth.ts', 'web/src/lib/auth-client.ts', 'api/test/auth.test.ts'].entries()) {
        activity('tool.start', { call_id: `read-${index}`, name: index === 0 ? 'read' : 'mcp__gond__read', title: index === 0 ? file : 'mcp__gond__read', input: { path: file } });
        activity('tool.end', { call_id: `read-${index}`, ok: true });
      }
      for (const index of [0, 1]) {
        activity('tool.start', { call_id: `search-${index}`, name: 'mcpToolCall', title: 'grep', input: { server: 'gond', tool: 'grep', arguments: { pattern: 'returnUrl' } } });
        activity('tool.end', { call_id: `search-${index}`, ok: true });
      }
      const explored = page.getByRole('button', { name: 'Viewed 4 files and ran 2 searches', exact: true });
      await expect(explored).toHaveAttribute('aria-expanded', 'false');
      await explored.focus(); await page.keyboard.press('Enter');
      await expect(explored).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByText('api/src/auth.ts', { exact: true })).toBeVisible();
      await page.keyboard.press('Enter');
      activity('text.delta', { text: "The mobile flow drops the return URL. I've updated the redirect and added a regression check." });
      for (const [index, file] of ['api/src/auth.ts', 'api/test/auth.test.ts'].entries()) {
        activity('tool.start', { call_id: `edit-${index}`, name: 'mcp__gond__edit', title: 'mcp__gond__edit', input: { path: file } });
        activity('tool.end', { call_id: `edit-${index}`, ok: true });
      }
      await expect(page.getByRole('button', { name: 'Updated 2 files', exact: true })).toHaveAttribute('aria-expanded', 'false');
      activity('tool.start', { call_id: 'check', name: 'commandExecution', title: 'npm run typecheck', input: { command: 'npm run typecheck' } });
      activity('tool.end', { call_id: 'check', ok: true, output: JSON.stringify([{ type: 'text', text: 'No type errors.' }]) });
      const typecheck = page.getByRole('button', { name: 'Typecheck finished', exact: true });
      await typecheck.click();
      await expect(page.getByText('No type errors.', { exact: true })).toBeVisible();
      await typecheck.click();
      activity('tool.start', { call_id: 'browser', name: 'mcp__gond__browser', title: 'mcp__gond__browser', input: { url: 'http://app/sign-in' } });
      await expect(page.getByRole('button', { name: 'Checking browser layouts', exact: true })).toBeVisible();
      expect((await page.locator('[data-slot=trace]').allTextContents()).join(' ')).not.toMatch(/mcp__|mcpToolCall|commandExecution/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByText("The mobile flow drops the return URL. I've updated the redirect and added a regression check.", { exact: true }).click();
      await capture('message-activity');
      activity('tool.end', { call_id: 'browser', ok: false, output: 'Expected /agents/; received /login.' });
      const failedCheck = page.getByRole('button', { name: 'Browser checks failed', exact: true });
      await expect(failedCheck).toBeVisible();
      await expect(page.getByText('Open details to see what happened.', { exact: true })).toBeVisible();
      await capture('message-activity-failed');
      await failedCheck.click();
      await expect(page.getByText('Expected /agents/; received /login.', { exact: true })).toBeVisible();
      await capture('message-activity-details');

      const tasks = page.getByRole('complementary', { name: 'Tasks', exact: true });
      await expect(tasks).toHaveCount(0);
      const plan = [{ text: 'Inspect sign-in flow', status: 'done' }, { text: 'Fix mobile return URL', status: 'in_progress' }, { text: 'Verify redirect behavior', status: 'pending' }];
      activity('todos', { agent_id: 'main', items: plan });
      await expect(tasks).toContainText('1 of 3 done');
      if (width === 390) {
        await expect(tasks.getByRole('list')).toBeHidden();
        await tasks.getByRole('button', { name: 'Expand tasks' }).click();
      }
      await expect(tasks.getByRole('listitem')).toHaveCount(3);
      await expect(tasks.locator('[aria-current=step]')).toHaveText('Fix mobile return URL');
      const top = (await tasks.boundingBox()).y;
      await page.getByText('Expected /agents/; received /login.', { exact: true }).evaluate(el => {
        let parent = el.parentElement;
        while (parent && getComputedStyle(parent).overflowY !== 'auto') parent = parent.parentElement;
        if (parent) parent.scrollTop = 0;
      });
      expect((await tasks.boundingBox()).y).toBe(top);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture('pinned-tasks');
      activity('todos', { agent_id: 'main', items: plan.map((step, i) => ({ ...step, status: i < 2 ? 'done' : 'in_progress' })) });
      await expect(tasks).toContainText('2 of 3 done');
      await expect(tasks.locator('[aria-current=step]')).toHaveText('Verify redirect behavior');
      if (width === 390) await tasks.getByRole('button', { name: 'Expand tasks' }).click();

      // A GitHub merge updates the existing PR card and every current-state icon.
      activePreview = false; prState = 'open';
      activity('run.pr', { number: 42, url: 'https://github.com/acme/app/pull/42', state: 'open' });
      activity('run.status', { status: 'ready' });
      await expect(page.getByRole('link', { name: 'Open pull request #42', exact: true }).first()).toBeVisible();
      prState = 'merged';
      activity('run.pr', { number: 42, url: 'https://github.com/acme/app/pull/42', state: 'merged' });
      activity('run.status', { status: 'merged' });
      const mergedLink = page.getByRole('link', { name: 'Merged pull request #42', exact: true }).first();
      await expect(mergedLink.locator('.lucide-git-merge')).toHaveCSS('color', 'rgb(188, 140, 255)');
      await expect(page.getByRole('link', { name: 'Open pull request #42', exact: true })).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Follow-up message', exact: true })).toBeDisabled();
      await capture('pr-merged-run');
      if (width !== 1440) await page.getByRole('tab', { name: 'Changes & PR', exact: true }).click();
      await page.getByRole('tab', { name: 'Pull request #42', exact: true }).click();
      await expect(page.getByText('Merged', { exact: true }).filter({ visible: true }).first()).toBeVisible();
      await capture('pr-merged-details');
      await page.goto(origin + '/agents/');
      const mergedChip = page.getByLabel('Merged pull request #42', { exact: true }).filter({ visible: true });
      await expect(mergedChip.locator('.lucide-git-merge')).toHaveCSS('color', 'rgb(188, 140, 255)');
      await capture('pr-merged-home');
      prState = 'closed';
      await page.reload();
      await expect(page.getByLabel('Closed pull request #42', { exact: true }).filter({ visible: true }).locator('.lucide-git-pull-request-closed')).toBeVisible();
      await expect(page.getByLabel('Merged pull request #42', { exact: true })).toHaveCount(0);
      prState = null;

      // Exercise removing the final real API connection. Subscription availability
      // is a UI fixture; saving, discovery and persistence use the packaged API.
      const meURL = origin + '/api/v1/me';
      const meRoute = async route => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...await response.json(), setup_required: false } });
      };
      const original = await (await page.request.get(settingsURL)).json();
      await page.route(meURL, meRoute);
      try {
        await page.goto(origin + '/agents/settings');
        const providers = page.locator('#providers');
        await expect(providers.getByRole('button', { name: 'Save changes', exact: true })).toBeVisible();
        while (await providers.locator('fieldset').count()) {
          const connection = providers.locator('fieldset').first();
          await advanced(connection, true);
          await connection.getByRole('button', { name: 'Remove provider', exact: true }).click();
        }
        await expect(providers.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
        const cleared = await save('Save changes');
        expect(cleared.status()).toBe(200);
        expect((await cleared.json()).connections).toEqual([]);
        await page.reload();
        await expect(providers.getByText('No API providers. ChatGPT plan sign-in works without an API connection.', { exact: true })).toBeVisible();
        await expect(providers.locator('fieldset')).toHaveCount(0);
        await providers.scrollIntoViewIfNeeded();
        await capture('subscription-empty-api-settings');
        await page.goto(origin + '/agents/');
        await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toContainText('GPT-5.4 mini');
        await expect(page.getByText(/API connection unavailable/)).toHaveCount(0);
      } finally {
        const restored = await page.request.put(settingsURL, { headers: { Origin: origin }, data: { ...original, connections: original.connections.map(connection => ({ ...connection, apiKey: connection.baseURL === providerOrigin + '/second/v1' ? key + '-second' : key })) } });
        expect(restored.status()).toBe(200);
        await page.unroute(meURL, meRoute);
      }
    } finally {
      await page.unroute(fixtureRunURL + '/images/stream-image', imageRoute);
      await page.unroute(catalogURL, modelRoute);
      await page.unroute(fixtureRunURL, runRoute);
      await page.unroute(origin + '/api/v1/runs?limit=100', listRoute);
      await page.unroute(fixtureRunURL + '/messages', messagesRoute);
      await page.unroute(fixtureRunURL + '/ticket', ticketRoute);
      await page.unroute(fixtureRunURL + '/diff', diffRoute);
      await page.goto(origin + '/agents/settings');
    }
  };
  try {
    await page.goto(origin + '/');
    await expect(page).toHaveURL(origin + '/agents/');
    expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: 'undefined' });
    const returning = process.env.PHASE === 'returning';
    if (returning) {
      await expect(page.getByRole('heading', { name: 'Sign in to Gond Agent', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Create administrator account', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Create an account', exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByRole('heading', { name: 'Create the administrator account', exact: true })).toBeVisible();
      await capture('first-account');
      await page.getByLabel('Name', { exact: true }).fill('Test Administrator');
    }
    await page.getByLabel('Email', { exact: true }).fill('admin@example.test');
    await page.getByLabel('Password', { exact: true }).fill('test-password-only-123456');
    await page.getByRole('button', { name: returning ? 'Sign in' : 'Create administrator account', exact: true }).click();
    if (!returning) {
      await expect(page.getByRole('heading', { name: 'Set up Gond Agent', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(['ChatGPT plan', 'Connect your API']);
      await expect(page.getByRole('radio')).toHaveText(['OpenAI', 'Anthropic']);
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveCount(0);
      await nameConnection(page, 'Fixture provider');
      await expect(page.getByLabel('OpenAI API protocol', { exact: true })).toBeHidden();
      await selectFormat(page, 'anthropic');
      await expect(page.getByText('https://api.anthropic.com/v1', { exact: true })).toBeVisible();
      await editURL(page);
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue('https://api.anthropic.com/v1');
      await selectFormat(page, 'openai-responses');
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue('https://api.openai.com/v1');
      await page.getByLabel('API base URL', { exact: true }).fill(providerOrigin + '/v1');
      await selectFormat(page, width === 1440 ? 'anthropic' : 'openai-responses');
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue(providerOrigin + '/v1');
      await page.getByLabel('API key', { exact: true }).fill(key);
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByRole('button', { name: '+ Add provider', exact: true }).click();
      const second = page.locator('fieldset').nth(1);
      await nameConnection(second, 'Second provider');
      await editURL(second);
      await second.getByLabel('API base URL', { exact: true }).fill(providerOrigin + '/second/v1');
      await second.getByLabel('API key', { exact: true }).fill(key + '-second');
      await second.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page.getByLabel('Model ID', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Default model', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Load models', exact: true })).toHaveCount(0);
      await expect(page.getByText('Voice transcription (optional)', { exact: true })).toHaveCount(0);
      await capture('provider-setup');
      const response = await save('Finish setup');
      expect(response.status()).toBe(200);
      const settings = await response.json();
      expect(settings.connections).toHaveLength(2);
      expect(settings.connections.every(c => c.hasKey && c.discover && c.models.length === 0)).toBe(true);
      expect(JSON.stringify(settings)).not.toContain(key);
    }
    await expect(page.getByRole('heading', { level: 1 })).toContainText(', Test');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('link', { name: 'Settings', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--tint-solid').trim())).toBe('#2b61b9');
    await expect(page.getByText('Self-hosted', { exact: true })).toHaveCount(0);
    if (width === 1440) {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
      await page.mouse.move(500, 300);
      await expect(expand.locator('svg').last()).toHaveCSS('opacity', '0');
      await expect(expand.locator('svg').first()).toHaveCSS('opacity', '1');
      await expect(expand.locator('svg').first()).toHaveAttribute('width', '28');
      const logo = await expand.locator('svg').first().boundingBox();
      expect(Math.abs(logo.x + logo.width / 2 - 34)).toBeLessThanOrEqual(1);
      await expand.hover();
      await expect(expand.locator('svg').last()).toHaveCSS('opacity', '1');
      await expect(page.getByRole('tooltip')).toHaveText('Expand sidebar');
      await capture('sidebar-logo-hover');
      for (const name of ['New agent', 'Search', 'Home', 'Usage', 'Plugins', 'Automations']) {
        const target = ['Home', 'Usage', 'Plugins', 'Automations'].includes(name) ? page.getByRole('link', { name, exact: true }) : page.getByRole('button', { name, exact: true }).first();
        await target.hover();
        await expect(page.getByRole('tooltip')).toHaveText(name);
      }
      await capture('sidebar-tooltip');
      await page.getByRole('button', { name: 'Account menu', exact: true }).hover();
      await expect(page.getByRole('tooltip')).toHaveText('Account');
      await page.getByRole('button', { name: 'Account menu', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toHaveAttribute('href', '/agents/settings');
      await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
      await capture('account-menu-collapsed');
      await page.keyboard.press('Escape');
      // Radix restores focus to the menu trigger asynchronously on close. Wait for
      // that restoration before moving focus, or it can steal focus back in CI.
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toBeFocused();
      await expand.focus();
      await expect(expand).toBeFocused();
      await expect(expand.locator('svg').last()).toHaveCSS('opacity', '1');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();
    } else await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const expandedLogo = page.locator('[aria-label="Gond Agent"] svg').filter({ visible: true });
    await expect(expandedLogo).toHaveAttribute('width', '28');
    const markBounds = await expandedLogo.boundingBox();
    const homeIconBounds = await page.getByRole('link', { name: 'Home', exact: true }).filter({ visible: true }).locator('svg').boundingBox();
    expect(Math.abs(markBounds.x + markBounds.width / 2 - homeIconBounds.x - homeIconBounds.width / 2)).toBeLessThanOrEqual(1);
    expect((await expandedLogo.locator('../..').boundingBox()).height).toBe(48);
    await capture('sidebar-option-a');
    const accountTrigger = page.getByRole('button', { name: 'Account menu', exact: true }).filter({ visible: true });
    const accountWidth = (await accountTrigger.boundingBox()).width;
    await accountTrigger.click();
    await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toHaveAttribute('href', '/agents/settings');
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
    const menuWidth = (await page.getByRole('menu').boundingBox()).width;
    expect(Math.abs(menuWidth - accountWidth)).toBeLessThanOrEqual(1);
    await capture('account-menu');
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(origin + '/agents/settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    if (!returning) {
      const categoryNames = ['Personal settings', 'Models', 'Security', 'Connections', 'People', 'Agent access', 'Account management'];
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(categoryNames);
      for (const name of categoryNames) {
        const heading = page.getByRole('heading', { name, exact: true, level: 2 });
        await heading.scrollIntoViewIfNeeded();
        const category = page.getByRole('region', { name, exact: true });
        const firstCard = category.locator('[data-slot="card"]').first();
        await expect(firstCard.getByRole('heading', { level: 3 })).toBeVisible();
        const style = await heading.evaluate(element => ({ size: parseFloat(getComputedStyle(element).fontSize), color: getComputedStyle(element).color, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
        expect(style.size).toBeGreaterThanOrEqual(22);
        expect(style.color).toBe('rgb(237, 237, 237)');
        expect(style.right).toBeLessThanOrEqual(width);
        expect(Math.abs(style.left - (await firstCard.boundingBox()).x)).toBeLessThanOrEqual(1);
        // Three overviews cover the page; repeat screenshots after restart add
        // no coverage for layout that does not depend on persisted state.
        if (['Personal settings', 'Security', 'Account management'].includes(name)) await capture('settings-category-' + name.toLowerCase().replaceAll(' ', '-'));
      }
    }
    await expect(page.getByRole('region', { name: 'Models', exact: true }).getByRole('heading', { level: 3 })).toHaveText(['ChatGPT plan', 'Model providers']);
    const mcp = page.locator('#mcp');
    await mcp.scrollIntoViewIfNeeded();
    if (!returning) {
      await expect(mcp.getByText('Create a token to connect your first agent.', { exact: true })).toBeVisible();
      await capture('mcp-empty');
      await mcp.getByLabel('Token name', { exact: true }).fill('Browser MCP test');
      await mcp.getByRole('button', { name: 'Create token', exact: true }).click();
      const tokenField = mcp.getByLabel('New MCP token', { exact: true });
      await expect(tokenField).toBeVisible();
      const bearer = await tokenField.inputValue();
      expect(bearer).toMatch(/^gond_mcp_/);
      await capture('mcp-created');
      const listed = await (await page.request.get(origin + '/api/v1/mcp/tokens')).json();
      expect(JSON.stringify(listed)).not.toContain(bearer);
      await page.reload();
      await expect(mcp.getByText('Browser MCP test', { exact: true })).toBeVisible();
      await expect(mcp.getByLabel('New MCP token', { exact: true })).toHaveCount(0);
      await mcp.getByRole('button', { name: 'Revoke', exact: true }).click();
      await expect(mcp.getByText(/Revoked/)).toBeVisible();
      const revoked = await page.request.post(origin + '/mcp', { headers: { Authorization: `Bearer ${bearer}` }, data: {} });
      expect(revoked.status()).toBe(401);
      await mcp.scrollIntoViewIfNeeded();
      await capture('mcp-revoked');
    } else {
      await expect(mcp.getByText('Browser MCP test', { exact: true })).toBeVisible();
      await expect(mcp.getByText(/Revoked/)).toBeVisible();
      await expect(mcp.getByLabel('New MCP token', { exact: true })).toHaveCount(0);
    }
    await page.goto(origin + '/agents/');
    if (width !== 1440) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Search', exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('option', { name: 'Settings', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const me = await (await page.request.get(origin + '/api/v1/me')).json();
    expect(me.admin).toBe(true); expect(me.setup_required).toBe(false);
    await expect(page.getByRole('button', { name: /Voice input|Turning your voice/ })).toHaveCount(0);
    const catalog = await (await page.request.get(origin + '/api/v1/models')).json();
    expect(catalog.models.filter(m => m.id.endsWith(':fixture-model'))).toHaveLength(2);
    expect(catalog.models.some(m => m.display_name === 'Fixture coder · Second provider')).toBe(true);
    expect(JSON.stringify(catalog)).not.toContain(key);
    await page.getByRole('button', { name: 'Choose model', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Fixture coder · Fixture provider', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fixture coder · Second provider', exact: true })).toBeVisible();
    await capture(returning ? 'model-picker-after-restart' : 'model-picker');
    await page.getByRole('button', { name: 'Fixture coder · Second provider', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose model', exact: true })).toContainText('Second provider');
    await capture(returning ? 'workspace-after-restart' : 'workspace');
    await page.goto(origin + '/agents/settings');
    const firstProvider = page.locator('#providers fieldset').first();
    await advanced(firstProvider, true);
    await expect(firstProvider.getByLabel('Connection name', { exact: true })).toHaveValue('Fixture provider');
    await advanced(firstProvider, false);
    await expect(page.getByLabel('API key', { exact: true }).first()).toHaveValue('');
    await expect(page.getByLabel('API key', { exact: true }).first()).toHaveAttribute('placeholder', 'Saved — paste a new key to replace');
    await expect(firstProvider.getByRole('radio', { name: width === 1440 ? 'Anthropic' : 'OpenAI', exact: true })).toHaveAttribute('aria-checked', 'true');
    if (width !== 1440) {
      await advanced(firstProvider, true);
      await expect(firstProvider.getByLabel('OpenAI API protocol', { exact: true })).toHaveValue('openai-responses');
      await advanced(firstProvider, false);
    }
    if (!returning) {
      await firstProvider.getByRole('button', { name: 'Clear key', exact: true }).click();
      await expect(firstProvider.getByText('Key will be cleared when you save.', { exact: true })).toBeVisible();
      await firstProvider.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(firstProvider.getByRole('button', { name: 'Clear key', exact: true })).toBeVisible();
      await editURL(firstProvider);
      await firstProvider.getByLabel('API base URL', { exact: true }).fill('not-a-url');
      await firstProvider.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(firstProvider.getByLabel('API base URL', { exact: true })).toBeVisible();
      expect(await firstProvider.getByLabel('API base URL', { exact: true }).evaluate(input => input.validity.valid)).toBe(false);
      await firstProvider.getByLabel('API base URL', { exact: true }).fill(providerOrigin + '/v1');
      await firstProvider.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(firstProvider.getByLabel('API base URL', { exact: true })).toHaveCount(0);
      await firstProvider.getByRole('button', { name: 'Clear key', exact: true }).click();
      await capture('provider-key-clear');
      const cleared = await save('Save changes');
      expect(cleared.status()).toBe(200);
      expect((await cleared.json()).connections[0].hasKey).toBe(false);
      await expect(firstProvider.getByRole('button', { name: 'Clear key', exact: true })).toHaveCount(0);
      await firstProvider.getByLabel('API key', { exact: true }).fill(key);
      const restored = await save('Save changes');
      expect(restored.status()).toBe(200);
      expect((await restored.json()).connections[0].hasKey).toBe(true);
      await expect(firstProvider.getByLabel('API key', { exact: true })).toHaveValue('');
      await capture('provider-key-restored');
    }
    if (!returning) {
      await page.getByRole('button', { name: '+ Add provider', exact: true }).click();
      const manual = page.locator('fieldset').nth(2);
      await nameConnection(manual, 'Manual provider');
      await selectFormat(manual, width === 1440 ? 'anthropic' : 'openai-responses');
      await editURL(manual);
      await manual.getByLabel('API base URL', { exact: true }).fill(providerOrigin + '/unsupported/v1');
      await manual.getByLabel('API key', { exact: true }).fill(key);
      await advanced(manual, true);
      await manual.getByRole('button', { name: 'Add manual model', exact: true }).click();
      await manual.getByLabel('Model ID', { exact: true }).fill('manual-model');
      expect((await save('Save changes')).status()).toBe(200);
      await page.goto(origin + '/agents/');
      await page.getByRole('button', { name: 'Choose model', exact: true }).click();
      await expect(page.getByRole('button', { name: 'manual-model · Manual provider', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Fixture coder · Second provider', exact: true })).toBeVisible();
      await capture('manual-model-fallback');
      await page.keyboard.press('Escape');
      await page.goto(origin + '/agents/settings');
    }
    if (!returning) await verifyComposers();
    const beforePhoto = await (await page.request.get(origin + '/api/v1/me')).json();
    if (returning) {
      expect(beforePhoto.user.has_photo).toBe(true);
      await expect(page.getByRole('img', { name: 'Profile photo', exact: true }).first()).toBeVisible();
      await capture('photo-after-restart');
      await page.getByRole('button', { name: 'Remove photo', exact: true }).click();
      await expect(page.getByText('Profile photo removed.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Upload photo', exact: true })).toBeVisible();
    } else {
      const photo = await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = 480; c.height = 320;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#2b61b9'; ctx.fillRect(0, 0, 480, 320);
        ctx.fillStyle = '#a5d6a7'; ctx.beginPath(); ctx.arc(180, 150, 95, 0, Math.PI * 2); ctx.fill();
        return c.toDataURL('image/png').split(',')[1];
      });
      await page.getByLabel('Choose profile photo', { exact: true }).setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(photo, 'base64') });
      await expect(page.getByRole('dialog', { name: 'Crop profile photo', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save photo', exact: true })).toBeEnabled();
      await page.getByLabel('Zoom', { exact: true }).focus(); await page.keyboard.press('ArrowRight');
      await capture('photo-crop');
      await page.getByRole('button', { name: 'Save photo', exact: true }).click();
      await expect(page.getByText('Profile photo saved.', { exact: true })).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Crop profile photo', exact: true })).toHaveCount(0);
      const saved = await (await page.request.get(origin + '/api/v1/me')).json();
      expect(saved.user.has_photo).toBe(true);
      expect((await page.request.get(origin + saved.user.image)).status()).toBe(200);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Change photo', exact: true })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Profile photo', exact: true }).first()).toBeVisible();
    }
    await capture('settings-' + (process.env.PHASE || 'bootstrap'));
    await page.goto(origin + '/agents/automations');
    await expect(page.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible();
    await expect(page.getByText('GitHub polling', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('switch', { name: 'Automatic pull requests', exact: true })).toBeVisible();
    await capture('automations');
    await page.goto(origin + '/agents/plugins');
    await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
    if (!returning) {
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).first().click();
      await expect(page.getByLabel('One-time code', { exact: true })).toHaveValue('ABCD-1234');
      await expect(page.getByRole('link', { name: 'Continue on GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/login/device');
      await capture('github-device-login');
      await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
      await expect(page.getByText('GitHub sign-in cancelled.', { exact: true })).toBeVisible();
      await expect(page.getByLabel('One-time code', { exact: true })).toHaveCount(0);
      writeFileSync(join(fixtureDir, 'fail'), 'yes');
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).first().click();
      await expect(page.getByText(/GitHub sign-in didn't finish/)).toBeVisible();
      await capture('github-login-error');
      unlinkSync(join(fixtureDir, 'fail'));
      await page.getByRole('button', { name: 'Connect GitHub', exact: true }).first().click();
      await expect(page.getByLabel('One-time code', { exact: true })).toHaveValue('ABCD-1234');
      writeFileSync(join(fixtureDir, 'approve'), 'yes');
    }
    await expect(page.getByText('Signed in as fixture-operator', { exact: true })).toBeVisible();
    const github = await (await page.request.get(origin + '/api/v1/github')).json();
    expect(github).toEqual({ configured: true, login: 'fixture-operator', managed: true });
    const repos = await (await page.request.get(origin + '/api/v1/github/repos')).json();
    expect(repos.repos[0].full_name).toBe('acme/app');
    expect(JSON.stringify(github) + JSON.stringify(repos)).not.toContain('fixture-only-github-token');
    await capture(returning ? 'github-after-restart' : 'github-connected');
    await page.goto(origin + '/agents/settings#connections');
    await expect(page.getByLabel('Use the shared GitHub connection for accounts without their own', { exact: true })).not.toBeChecked();
    await expect(page.getByText('Shared connection (used by accounts without their own). The fallback also permits service credentials from the server environment. New accounts need their own connection unless it is on.', { exact: true })).toBeVisible();
    await page.getByRole('heading', { name: 'Shared connection', exact: true }).scrollIntoViewIfNeeded();
    await capture('github-admin-shared');
    await page.goto(origin + '/agents/settings#people-settings');
    await page.getByRole('heading', { name: 'People', level: 3, exact: true }).scrollIntoViewIfNeeded();
    await capture('people-role-actions');
    if (returning) {
      const memberContext = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const member = await memberContext.newPage();
      try {
        const signed = await member.request.post(origin + '/api/auth/sign-in/email', { headers: { Origin: origin }, data: { email: 'member@example.test', password: 'test-password-only-123456' } });
        expect(signed.status()).toBe(200);
        await member.goto(origin + '/agents/settings#connections');
        await expect(member.getByText('Connect your own GitHub account here. Your runs and pull requests use it.', { exact: true })).toBeVisible();
        await expect(member.getByRole('button', { name: 'Connect GitHub', exact: true })).toBeVisible();
        await expect(member.getByRole('heading', { name: 'Shared connection', exact: true })).toHaveCount(0);
        await capture('github-non-admin-disconnected', member);
        await member.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
        await expect(member.getByText('Signed in as fixture-operator', { exact: true })).toBeVisible();
        await expect(member.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
        await expect(member.getByText('This removes the saved connection from this server. To revoke access completely, remove the app in your GitHub settings.', { exact: true })).toBeVisible();
        await capture('github-non-admin-connected', member);
        await member.getByRole('button', { name: 'Disconnect', exact: true }).click();
        await expect(member.getByText('Not connected', { exact: true })).toBeVisible();
        expect((await member.request.get(origin + '/api/v1/github/repos')).status()).toBe(409);
        const removed = await member.request.delete(origin + '/api/v1/me', { headers: { Origin: origin }, data: { confirmation: 'member@example.test', password: 'test-password-only-123456' } });
        expect(removed.status()).toBe(200);
      } finally { await memberContext.close(); }
    }
    await page.goto(origin + '/agents/plugins');
    if (width !== 1440) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Account menu', exact: true }).filter({ visible: true }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Gond Agent', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create an account', exact: true })).toHaveCount(0);
    if (returning) {
      await page.getByLabel('Email', { exact: true }).fill('admin@example.test');
      await page.getByLabel('Password', { exact: true }).fill('test-password-only-123456');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1 })).toContainText(', Test');
      if (width !== 1440) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await page.getByRole('button', { name: 'Search', exact: true }).filter({ visible: true }).click();
      await page.getByRole('textbox', { name: 'Search', exact: true }).fill('delete account');
      await page.getByRole('option', { name: 'Delete account', exact: true }).click();
      await expect(page).toHaveURL(origin + '/agents/settings#delete');
      await expect(page.locator('#delete').getByRole('heading', { name: 'Delete account', exact: true })).toBeVisible();
      await page.locator('#chatgpt').scrollIntoViewIfNeeded();
      await expect(page.getByText('ChatGPT plan', { exact: true })).toBeVisible();
      await expect(page.locator('#chatgpt').getByRole('button', { name: 'Continue with ChatGPT', exact: true })).toBeVisible();
      await expect(page.locator('#chatgpt').getByText('No ChatGPT accounts. Sign in to use your plan with the built-in agent.', { exact: true })).toBeVisible();
      await capture('subscription-settings');
      await page.locator('#delete').scrollIntoViewIfNeeded();
      await capture('delete-account-settings');
      await page.getByRole('button', { name: 'Delete account', exact: true }).click();
      const confirmation = page.getByRole('alertdialog', { name: 'Delete your account?', exact: true });
      await expect(confirmation).toBeVisible();
      await expect(confirmation).toContainText('This is the only account.');
      const permanentlyDelete = confirmation.getByRole('button', { name: 'Permanently delete account', exact: true });
      await expect(permanentlyDelete).toBeDisabled();
      await confirmation.getByLabel('Type admin@example.test to confirm', { exact: true }).fill('admin@example.test');
      await confirmation.getByLabel('Current password', { exact: true }).fill('test-password-only-123456');
      await expect(permanentlyDelete).toBeEnabled();
      await capture('delete-account-confirmation');
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(confirmation).toHaveCount(0);
      expect((await page.request.get(origin + '/api/v1/me')).status()).toBe(200);
      await page.getByRole('button', { name: 'Delete account', exact: true }).click();
      await expect(confirmation.getByLabel('Current password', { exact: true })).toHaveValue('');
      await expect(confirmation.getByLabel('Type admin@example.test to confirm', { exact: true })).toHaveValue('');
      await confirmation.getByLabel('Type admin@example.test to confirm', { exact: true }).fill('admin@example.test');
      await confirmation.getByLabel('Current password', { exact: true }).fill('incorrect-password');
      await permanentlyDelete.click();
      await expect(confirmation.getByRole('alert')).toHaveText('Your current password is incorrect.');
      await confirmation.getByLabel('Current password', { exact: true }).fill('test-password-only-123456');
      const deleting = page.waitForResponse(r => r.url() === origin + '/api/v1/me' && r.request().method() === 'DELETE');
      await permanentlyDelete.click();
      const deleted = await deleting;
      expect(deleted.status()).toBe(200);
      await expect(page.getByRole('heading', { name: 'Create the administrator account', exact: true })).toBeVisible();
      expect(await (await page.request.get(origin + '/api/auth/bootstrap')).json()).toEqual({ firstAccount: true, signupAllowed: true, providers: [] });
      await capture('delete-account-back-to-registration');
      await page.getByLabel('Name', { exact: true }).fill('Reset Administrator');
      await page.getByLabel('Email', { exact: true }).fill('reset@example.test');
      await page.getByLabel('Password', { exact: true }).fill('test-password-only-123456');
      await page.getByRole('button', { name: 'Create administrator account', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Set up Gond Agent', exact: true })).toBeVisible();
      await capture('delete-account-back-to-model-setup');
      await nameConnection(page, 'Fresh provider');
      await editURL(page);
      await page.getByLabel('API base URL', { exact: true }).fill(providerOrigin + '/v1');
      await page.getByLabel('API key', { exact: true }).fill(key);
      expect((await save('Finish setup')).status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toContainText(', Reset');
      const reset = await (await page.request.get(origin + '/api/v1/me')).json();
      expect(reset.admin).toBe(true); expect(reset.setup_required).toBe(false);
      await capture('delete-account-fresh-workspace');
    }
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ passed: true, width, phase: process.env.PHASE, screenshots }));
  } catch (error) {
    await capture('failure').catch(() => {});
    console.log(JSON.stringify({ error: error.message, screenshots }));
  } finally {
    await browser.close(); await new Promise(resolve => provider.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
