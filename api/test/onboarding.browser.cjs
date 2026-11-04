// Runs inside the worker image against the packaged service. Explicit UI preview
// fixtures below replace selected endpoints without starting paid model calls.
const { verifyPagination } = require((process.env.GOND_AGENT_GH_FIXTURE_DIR || '/fixture') + '/home-pagination.browser.cjs');
const { chromium, expect } = require('@playwright/test');
const { createServer } = require('node:http');
const { mkdirSync, writeFileSync, unlinkSync } = require('node:fs');
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
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
  const errors = [];
  const externalRequests = [];
  const authResponses = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== origin || !url.pathname.startsWith('/api/auth/')) return;
    authResponses.push({ path: url.pathname, method: response.request().method(), status: response.status(), retryAfter: response.headers()['x-retry-after'] });
    if (authResponses.length > 30) authResponses.shift();
  });
  page.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
  const greyAvatar = async (locator, theme = 'dark') => {
    await expect(locator).toBeVisible();
    await expect(locator).toHaveCSS('background-color', theme === 'light' ? 'rgb(235, 232, 225)' : 'rgb(26, 26, 26)');
    await expect(locator).toHaveCSS('color', theme === 'light' ? 'rgb(82, 79, 74)' : 'rgb(138, 138, 138)');
    await expect(locator.locator('svg.lucide-user-round')).toBeVisible();
    await expect(locator).toHaveText('');
  };
  page.on('pageerror', error => errors.push(error.message));
  const capture = async (name, target = page) => screenshots.push({ name: `${name}-${width}.png`, data: (await target.screenshot({ fullPage: true, animations: 'disabled', mask: [target.getByLabel('New MCP token', { exact: true })] })).toString('base64') });
  const resolvedTheme = async (theme, target = page, preference = theme) => {
    const html = target.locator('html');
    await expect(html).toHaveAttribute('data-theme', preference);
    if (theme === 'dark') await expect(html).toHaveClass(/\bdark\b/);
    else await expect(html).not.toHaveClass(/\bdark\b/);
    await expect(html).toHaveCSS('color-scheme', theme);
    if (theme === 'light') await expect.poll(() => html.evaluate(element => getComputedStyle(element).getPropertyValue('--background').trim())).toBe('#f5f3ee');
    await expect(target.locator('meta[name="theme-color"]')).toHaveAttribute('content', theme === 'light' ? '#f5f3ee' : /^(#000000|#000)$/);
    await expect(target.locator('body')).toHaveCSS('background-color', theme === 'light' ? 'rgb(245, 243, 238)' : 'rgb(0, 0, 0)');
  };
  // The theme checks leave System selected with a dark device. Reuse the existing
  // transcript/plan/composer fixtures in both palettes without replaying events.
  const captureThemes = async name => {
    try {
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme });
        await resolvedTheme(theme, page, 'system');
        for (const avatar of await page.getByLabel('No profile photo', { exact: true }).filter({ visible: true }).all()) await greyAvatar(avatar, theme);
        for (const mark of await page.locator('svg rect[fill="#1b1a18"]').filter({ visible: true }).all()) await expect(mark).toHaveCSS('fill', 'rgb(27, 26, 24)');
        for (const heading of await page.locator('[data-settings-category] > h2').all()) await expect(heading).toHaveCSS('color', theme === 'light' ? 'rgb(27, 26, 24)' : 'rgb(237, 237, 237)');
        await capture(name + '-' + theme);
      }
    } finally {
      await page.emulateMedia({ colorScheme: 'dark' });
      await resolvedTheme('dark', page, 'system');
    }
  };
  const chooseTheme = async theme => {
    await page.getByRole('combobox', { name: 'Theme', exact: true }).click();
    await expect(page.getByRole('option')).toHaveText(['System', 'Light', 'Dark']);
    const saving = page.waitForResponse(response => response.url() === origin + '/api/v1/me/theme' && response.request().method() === 'PUT');
    await page.getByRole('option', { name: theme, exact: true }).click();
    const saved = await saving;
    expect(saved.status()).toBe(200);
    expect(saved.request().postDataJSON()).toEqual({ theme: theme.toLowerCase() });
    expect((await (await page.request.get(origin + '/api/v1/me')).json()).theme).toBe(theme.toLowerCase());
    await expect.poll(() => page.evaluate(() => localStorage.getItem('gond-agent-theme'))).toBe(theme.toLowerCase());
  };
  const verifyTheme = async () => {
    await expect(page.getByRole('heading', { name: 'Appearance', level: 3, exact: true })).toBeVisible();
    await chooseTheme('Light');
    await resolvedTheme('light');
    const avatar = page.getByLabel('No profile photo', { exact: true }).filter({ visible: true }).last();
    if (await avatar.count()) await greyAvatar(avatar, 'light');
    await capture('settings-appearance-light');

    // Hold all external scripts during reload: only the synchronous inline boot
    // script can apply the cached preference, before React or /me can fix it.
    let releaseScripts;
    const scriptsReady = new Promise(resolve => { releaseScripts = resolve; });
    const holdScripts = async route => {
      if (route.request().resourceType() === 'script') await scriptsReady;
      await route.continue();
    };
    await page.route('**/*', holdScripts);
    try {
      const response = await page.reload({ waitUntil: 'commit' });
      expect(response.headers()['content-security-policy']).toBe("img-src 'self' data: blob:");
      await resolvedTheme('light');
      await expect(page.locator('#root')).toBeEmpty();
    } finally {
      releaseScripts();
      await page.waitForLoadState('load');
      await page.unroute('**/*', holdScripts);
    }
    await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveText('Light');
    await resolvedTheme('light');

    // Same authenticated user, but no localStorage/cache and an opposing device
    // preference: this context must obtain Light from the real saved profile.
    const state = await page.context().storageState();
    const freshContext = await browser.newContext({ storageState: { ...state, origins: [] }, viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
    const fresh = await freshContext.newPage();
    fresh.on('pageerror', error => errors.push(error.message));
    fresh.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
    try {
      await fresh.goto(origin + '/agents/settings');
      await expect(fresh.getByRole('combobox', { name: 'Theme', exact: true })).toHaveText('Light');
      await resolvedTheme('light', fresh);
      expect((await (await fresh.request.get(origin + '/api/v1/me')).json()).user.id).toBe((await (await page.request.get(origin + '/api/v1/me')).json()).user.id);
      await capture('settings-appearance-light-fresh-context', fresh);
    } finally { await freshContext.close(); }

    // A delayed failed save must show the choice optimistically, then restore the
    // previous server value and cache with a plain, dismissible error toast.
    let releaseFailure;
    const failedSave = new Promise(resolve => { releaseFailure = resolve; });
    await page.route(origin + '/api/v1/me/theme', async route => {
      await failedSave;
      await route.fulfill({ status: 500, json: { error: { code: 'fixture_failure', message: 'Could not save.' } } });
    }, { times: 1 });
    await page.getByRole('combobox', { name: 'Theme', exact: true }).click();
    await page.getByRole('option', { name: 'Dark', exact: true }).click();
    try { await resolvedTheme('dark'); } finally { releaseFailure(); }
    await resolvedTheme('light');
    await expect(page.getByRole('alert')).toContainText("Couldn't change the theme. Try again.");
    await expect.poll(() => page.evaluate(() => localStorage.getItem('gond-agent-theme'))).toBe('light');
    expect((await (await page.request.get(origin + '/api/v1/me')).json()).theme).toBe('light');
    await page.getByRole('button', { name: 'Dismiss theme error', exact: true }).click();

    await chooseTheme('Dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await resolvedTheme('dark'); // Explicit Dark ignores the device preference.
    await capture('settings-appearance-dark');
    await chooseTheme('System');
    await resolvedTheme('light', page, 'system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await resolvedTheme('dark', page, 'system');
    await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveText('System');
  };
  const agentHeaders = async () => {
    const headers = page.locator('[data-agent-label]');
    await expect(headers.first()).toBeVisible();
    for (const header of await headers.all()) {
      await expect(header).toHaveText('Agent');
      const mark = header.getByRole('img', { name: 'Gond Agent', exact: true });
      await expect(mark).toBeVisible();
      await expect(mark.locator('svg')).toHaveAttribute('width', '16');
      await expect(mark.locator('svg')).toHaveAttribute('height', '16');
      await expect(header.locator('svg')).toHaveCount(1);
      await expect(header.locator('[data-model-provider], img, [style*="background-image"]')).toHaveCount(0);
      await expect(header).not.toContainText(/OpenAI|Anthropic|xAI|Claude|Codex/);
    }
  };
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
  const verifyAccents = async () => {
    const accentURL = origin + '/api/v1/me/accent';
    const cacheKey = 'gond-agent-accent';
    const control = target => target.locator('#appearance').getByRole('button', { name: 'Color', exact: true });
    const primary = target => target.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
    const unchangedIdentity = async target => {
      const scheme = await target.locator('html').evaluate(element => element.classList.contains('dark') ? 'dark' : 'light');
      await greyAvatar(target.getByRole('region', { name: 'Personal settings', exact: true }).getByLabel('No profile photo', { exact: true }), scheme);
      const marks = target.locator('[aria-label="Gond Agent"] svg');
      expect(await marks.count()).toBeGreaterThan(0);
      for (const mark of await marks.all()) {
        await expect(mark.locator('rect').first()).toHaveAttribute('fill', '#1b1a18');
        await expect(mark.locator('rect').first()).toHaveCSS('fill', 'rgb(27, 26, 24)');
        await expect(mark.locator('path')).toHaveCSS('stroke', 'rgb(255, 255, 255)');
        await expect(mark.locator('circle')).toHaveCSS('fill', 'rgb(255, 255, 255)');
      }
    };
    const state = async (target, name, color) => {
      const accent = name.toLowerCase();
      await expect(target.locator('html')).toHaveAttribute('data-accent', accent);
      await expect.poll(() => primary(target)).toBe(color);
      await expect(control(target)).toHaveText(name);
      await expect.poll(() => target.evaluate(key => localStorage.getItem(key), cacheKey)).toBe(accent);
      await unchangedIdentity(target);
    };
    const selected = async (target, name, shot) => {
      await expect(control(target)).toBeEnabled();
      await control(target).click();
      await expect(target.getByRole('menuitemradio', { name, exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(target.locator('[role="menuitemradio"][aria-checked="true"]')).toHaveCount(1);
      if (shot) await capture(shot, target);
      await target.keyboard.press('Escape');
      await expect(target.getByRole('menu')).toHaveCount(0);
      await expect(control(target)).toBeFocused();
    };
    const choose = async (name, keyboard = false) => {
      if (keyboard) {
        await control(page).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('menuitemradio', { name: 'Blue', exact: true })).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(page.getByRole('menuitemradio', { name, exact: true })).toBeFocused();
      } else await control(page).click();
      const saving = page.waitForResponse(response => response.url() === accentURL && response.request().method() === 'PUT');
      if (keyboard) await page.keyboard.press('Enter');
      else await page.getByRole('menuitemradio', { name, exact: true }).click();
      const response = await saving;
      expect(response.status()).toBe(200);
      expect(await response.json()).toEqual({ accent: name.toLowerCase() });
    };
    await page.goto(origin + '/agents/settings#appearance');
    await expect(page.locator('#appearance').getByRole('heading', { name: 'Appearance', level: 3, exact: true })).toBeVisible();
    await state(page, 'Blue', '#2b61b9');
    let previous = await primary(page);
    // No copied cookies or storage: the same account retrieves its color from the server.
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', colorScheme: 'dark' });
    const other = await context.newPage();
    other.on('pageerror', error => errors.push(error.message));
    other.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== origin) externalRequests.push(request.url()); });
    try {
      await other.goto(origin + '/agents/');
      await expect(other.getByRole('heading', { name: 'Sign in to Gond Agent', exact: true })).toBeVisible();
      await other.evaluate(key => localStorage.setItem(key, 'not-an-accent'), cacheKey);
      await other.reload();
      await other.getByLabel('Email', { exact: true }).fill('admin@example.test');
      await other.getByLabel('Password', { exact: true }).fill('test-password-only-123456');
      await other.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(other.getByRole('heading', { level: 1 })).toContainText(', Test');
      // Representative choices, not a second copy of the supported-color catalog.
      for (const [name, color] of [['Purple', '#6747ba'], ['Green', '#17853e'], ['Orange', '#c1450b']]) {
        await choose(name, name === 'Purple');
        await state(page, name, color);
        expect(await primary(page)).not.toBe(previous);
        previous = color;
        await page.reload();
        await state(page, name, color);
        await page.getByRole('region', { name: 'Personal settings', exact: true }).scrollIntoViewIfNeeded();
        await selected(page, name, 'accent-' + name.toLowerCase());
        await other.goto(origin + '/agents/settings#appearance');
        await other.reload();
        await state(other, name, color);
        await selected(other, name);
      }
      // Color and Theme share Appearance, but remain independent account choices.
      // System changes the shades, never the selected color or neutral identity.
      await page.emulateMedia({ colorScheme: 'light' });
      await resolvedTheme('light', page, 'system');
      await state(page, 'Orange', '#c2460c');
      await page.reload();
      await resolvedTheme('light', page, 'system');
      await state(page, 'Orange', '#c2460c');
      await page.getByRole('region', { name: 'Personal settings', exact: true }).scrollIntoViewIfNeeded();
      await selected(page, 'Orange', 'accent-orange-light');
      await page.emulateMedia({ colorScheme: 'dark' });
      await resolvedTheme('dark', page, 'system');
      await state(page, 'Orange', previous);
      // Both a valid-but-stale hint and an invalid hint lose to the account response.
      for (const target of [page, other]) {
        for (const hint of ['purple', 'not-an-accent']) {
          await target.evaluate(({ key, hint }) => localStorage.setItem(key, hint), { key: cacheKey, hint });
          await target.reload();
          await state(target, 'Orange', previous);
          await selected(target, 'Orange');
        }
      }
    } finally { await context.close(); }

    // Hold only the failing PUT so the optimistic DOM, control and cache are observable.
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const failSave = async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      await pending;
      await route.fulfill({ status: 500, json: { error: 'Internal server error' } });
    };
    await page.route(accentURL, failSave);
    try {
      await control(page).click();
      const requested = page.waitForRequest(request => request.url() === accentURL && request.method() === 'PUT');
      await page.getByRole('menuitemradio', { name: 'Purple', exact: true }).click();
      expect((await requested).postDataJSON()).toEqual({ accent: 'purple' });
      await state(page, 'Purple', '#6747ba');
      await expect(control(page)).toBeDisabled();
      const failed = page.waitForResponse(response => response.url() === accentURL && response.request().method() === 'PUT');
      release();
      expect((await failed).status()).toBe(500);
      await expect(page.getByText("Couldn't save your color. Try again.", { exact: true })).toBeVisible();
      await state(page, 'Orange', previous);
      await selected(page, 'Orange', 'accent-save-rollback');
    } finally {
      release();
      await page.unroute(accentURL, failSave);
    }
    await page.reload();
    await state(page, 'Orange', previous);
    await selected(page, 'Orange');
    // Keep the existing photo and later workspace screenshots on the default palette.
    await choose('Blue');
    await page.reload();
    await state(page, 'Blue', '#2b61b9');
    await selected(page, 'Blue');
    await page.goto(origin + '/agents/settings');
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
    let current = models[0], retiredBackend, sent, imageRequests = 0, activePreview = false, prState = null, queuePosition, largeDiff = false;
    const sockets = [];
    const run = () => ({ id: 'composer-fixture', user_id: 'fixture', repo: 'acme/app', base_branch: 'main', branch: 'fixture', model_id: current.id, backend: current.backend, retired_backend: retiredBackend, effort: 'medium', title: largeDiff ? 'Failing test first for bug fixes' : 'Composer preview', prompt: 'Review the settings', status: queuePosition ? 'queued' : activePreview ? 'working' : prState === 'merged' ? 'merged' : 'ready', queue_position: queuePosition, queue_length: queuePosition ? 3 : undefined, pr_state: prState, pr_number: prState ? 42 : null, pr_url: prState ? 'https://github.com/acme/app/pull/42' : null, files: largeDiff ? 77 : 0, additions: largeDiff ? 11456 : 0, deletions: largeDiff ? 99999 : 0, created_at: Date.now(), updated_at: Date.now(), live: { phase: 'idle' } });
    const modelRoute = route => route.fulfill({ json: { models, connections } });
    const runRoute = route => route.fulfill({ json: run() });
    const listRoute = route => {
      const rows = prState || queuePosition || largeDiff ? [run()] : [];
      return route.fulfill({ json: { runs: rows, total: rows.length, limit: 100, offset: 0, repositories: ['acme/app'], counts: { all: rows.length, working: rows.filter(r => ['working', 'queued'].includes(r.status)).length, active: rows.filter(r => r.status === 'working').length, queued: queuePosition ? 1 : 0, ready: rows.filter(r => r.status === 'ready').length, merged: rows.filter(r => r.status === 'merged').length } } });
    };
    const stopRoute = route => { queuePosition = undefined; return route.fulfill({ json: { ok: true } }); };
    const messagesRoute = route => { sent = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }); };
    const ticketRoute = route => route.fulfill({ json: { ticket: 'composer-fixture' } });
    const fixtureDiff = 'diff --git a/api/src/auth.ts b/api/src/auth.ts\n--- a/api/src/auth.ts\n+++ b/api/src/auth.ts\n@@ -1,3 +1,3 @@\n export function returnURL() {\n-  return "/login"\n+  return "/agents/"\n }\n';
    const diffRoute = route => route.fulfill({ body: fixtureDiff });
    const imageRoute = route => { imageRequests++; return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64') }); };
    await page.route(catalogURL, modelRoute);
    await page.route(fixtureRunURL, runRoute);
    await page.route(origin + '/api/v1/runs?*', listRoute);
    await page.route(fixtureRunURL + '/messages', messagesRoute);
    await page.route(fixtureRunURL + '/stop', stopRoute);
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
      largeDiff = true;
      await page.goto(origin + '/agents/');
      const card = page.locator('li').filter({ hasText: 'Failing test first for bug fixes' });
      await expect(card).toBeVisible();
      const counts = card.locator('[data-diff-counts]').filter({ visible: true });
      await expect(counts).toHaveText('+11.4k−99.9k');
      await expect(counts).toHaveAttribute('title', '+11456 −99999');
      // Check descendants, not just scrollWidth or the flex wrapper: text can
      // paint outside an otherwise correctly sized flex item.
      expect(await card.evaluate(card => {
        const tile = card.querySelector('[data-diff-tile]');
        const box = tile && tile.getBoundingClientRect().width ? tile : card;
        const bounds = box.getBoundingClientRect();
        return [...box.querySelectorAll('[data-diff-counts], [data-diff-counts] > span, [data-diff-squares], [data-diff-squares] > span')].every(el => {
          const r = el.getBoundingClientRect();
          return !r.width || r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom;
        }) && card.scrollWidth <= card.clientWidth;
      })).toBe(true);
      if (width >= 768) await expect(card.locator('[data-diff-squares] > span')).toHaveCount(5);
      await captureThemes('runs-large-diff');
      largeDiff = false;
      await page.goto(origin + '/agents/');
      await page.getByRole('button', { name: 'Choose model', exact: true }).click();
      for (const model of models) {
        await expect(page.getByRole('button', { name: model.display_name, exact: true }).locator('[data-model-provider]')).toHaveAttribute('data-model-provider', model.provider);
      }
      await captureThemes('model-menu-brands');
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
      await captureThemes('thinking-menu');
      await page.keyboard.press('Escape');
      await captureThemes('subscription-no-api-warning');
      for (const model of models) {
        current = model;
        await page.goto(origin + '/agents/runs/composer-fixture');
        const picker = page.getByRole('button', { name: 'Follow-up model', exact: true });
        await expect(picker).toContainText(model.display_name.replace(/^Claude /, ''));
        await expect(picker.locator('[data-model-provider]')).toHaveAttribute('data-model-provider', model.provider);
        await expect.poll(() => sockets.length).toBe(models.indexOf(model) + 1);
        sockets.at(-1).send(JSON.stringify({ seq: 1, ts: Date.now(), type: 'user', text: 'Review the settings' }));
        sockets.at(-1).send(JSON.stringify({ seq: 2, ts: Date.now(), type: 'text.delta', text: 'I will check the settings layout and model selection.' }));
        await agentHeaders();
        await capture('agent-label-' + model.id.replaceAll(/[^a-zA-Z0-9-]/g, '-'));
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
        await agentHeaders();
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
      const message = { seq: 3, ts: Date.now(), type: 'user', text: 'Fix sign-in on mobile. It sends me back to the login screen.', images: [{ id: 'stream-image' }] };
      sockets.at(-1).send(JSON.stringify(message));
      const attachedImage = page.getByRole('img', { name: 'Attached image', exact: true });
      await expect(attachedImage).toBeVisible();
      await expect.poll(() => attachedImage.evaluate(img => img.naturalWidth)).toBe(1);
      const imageURL = await attachedImage.getAttribute('src');
      sockets.at(-1).send(JSON.stringify({ seq: 4, ts: Date.now(), type: 'text.delta', text: 'Checking' }));
      await expect(page.getByText('Checking', { exact: true })).toBeVisible();
      sockets.at(-1).send(JSON.stringify({ seq: 5, ts: Date.now(), type: 'text.delta', text: ' now' }));
      sockets.at(-1).send(JSON.stringify({ seq: 4, ts: Date.now(), type: 'text.delta', text: 'Checking' }));
      await expect(page.getByText('Checking now', { exact: true })).toBeVisible();
      await greyAvatar(page.getByLabel('No profile photo', { exact: true }).filter({ visible: true }).last());
      await agentHeaders();
      await capture('streamed-transcript-image');
      // verifyTheme leaves System saved. Device changes resolve the palette, not
      // the account preference; use the helper that checks both independently.
      await captureThemes('streamed-transcript-image');
      expect((await (await page.request.get(origin + '/api/v1/me')).json()).theme).toBe('system');
      const inlineImage = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 2;
        const data = canvas.toDataURL('image/png');
        return { data, blob: URL.createObjectURL(new Blob([Uint8Array.from(atob(data.split(',')[1]), ch => ch.charCodeAt(0))], { type: 'image/png' })) };
      });
      const remoteImage = 'https://remote.example.test/tracking.png';
      const bareImage = 'https://remote.example.test/no-alt.png';
      sockets.at(-1).send(JSON.stringify({ seq: 6, ts: Date.now(), type: 'text.delta', text: `\n\n![Remote diagram](${remoteImage})\n\n![](${bareImage})\n\n![Local diagram](${origin}/agents/favicon-32.png)\n\n![Data diagram](${inlineImage.data})\n\n![Blob diagram](${inlineImage.blob})` }));
      await expect(page.getByRole('link', { name: 'Remote diagram', exact: true })).toHaveAttribute('href', remoteImage);
      await expect(page.getByRole('link', { name: bareImage, exact: true })).toHaveAttribute('href', bareImage);
      await expect(page.locator('img[src*="remote.example.test"]')).toHaveCount(0);
      for (const name of ['Local diagram', 'Data diagram', 'Blob diagram']) {
        const image = page.getByRole('img', { name, exact: true });
        await expect(image).toBeVisible();
        await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
      }
      await capture('markdown-image-links');
      await page.evaluate(url => URL.revokeObjectURL(url), inlineImage.blob);
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
      let activitySeq = 3;
      const activity = (type, fields) => sockets.at(-1).send(JSON.stringify({ seq: ++activitySeq, ts: Date.now(), type, ...fields }));
      queuePosition = 2;
      activity('run.queued', { position: 2, length: 3 });
      await expect(page.getByRole('status').filter({ hasText: 'Waiting for a free workspace' })).toHaveText('Waiting for a free workspace (position 2 of 3)');
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
      queuePosition = 1;
      activity('run.queued', { position: 1, length: 3 });
      await expect(page.getByRole('status').filter({ hasText: 'Waiting for a free workspace' })).toHaveText('Waiting for a free workspace (position 1 of 3)');
      queuePosition = undefined;
      activePreview = true;
      activity('run.dequeued', {});
      await expect(page.getByText('Waiting for a free workspace', { exact: false })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
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
      await agentHeaders();
      await capture('message-activity');
      activity('tool.end', { call_id: 'browser', ok: false, output: 'Expected /agents/; received /login.' });
      const failedCheck = page.getByRole('button', { name: 'Browser checks failed', exact: true });
      await expect(failedCheck).toBeVisible();
      await expect(page.getByText('Open details to see what happened.', { exact: true })).toBeVisible();
      await agentHeaders();
      await capture('message-activity-failed');
      await failedCheck.click();
      await expect(page.getByText('Expected /agents/; received /login.', { exact: true })).toBeVisible();
      await capture('message-activity-details');
      await captureThemes('message-activity-details');

      const noPinnedTasks = async () => {
        await expect(page.getByRole('complementary', { name: 'Tasks', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Expand tasks', exact: true })).toHaveCount(0);
        await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toHaveCount(0);
        await expect(page.getByText(/Tasks\s+\d+ of \d+ done/)).toHaveCount(0);
      };
      await noPinnedTasks();
      await capture('run-without-plan');
      const plan = [{ text: 'Inspect sign-in flow', status: 'done' }, { text: 'Fix mobile return URL', status: 'in_progress' }, { text: 'Verify redirect behavior', status: 'pending' }];
      activity('todos', { agent_id: 'main', items: plan });
      const checklist = page.getByRole('list').filter({ hasText: 'Inspect sign-in flow' });
      await expect(checklist.getByRole('listitem')).toHaveText(plan.map(step => step.text));
      await expect(checklist.locator('svg.lucide-check')).toHaveCount(1);
      await checklist.scrollIntoViewIfNeeded();
      await expect(checklist).toBeVisible();
      // The surviving checklist must live inside the transcript's scroller.
      expect(await checklist.evaluate(el => {
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowY === 'auto') return true;
        }
        return false;
      })).toBe(true);
      await noPinnedTasks();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await capture('in-chat-plan');
      await captureThemes('in-chat-plan');
      activity('todos', { agent_id: 'main', items: plan.map((step, i) => ({ ...step, status: i < 2 ? 'done' : 'in_progress' })) });
      await expect(checklist.locator('svg.lucide-check')).toHaveCount(2);
      await expect(checklist.getByRole('listitem')).toHaveText(plan.map(step => step.text));
      await noPinnedTasks();

      // Keep the original activity-summary fixture above unchanged. Only this
      // later call supplies a diff for the light/dark Changes screenshots.
      activity('tool.start', { call_id: 'diff-preview', name: 'edit', title: 'api/src/auth.ts', input: { path: 'api/src/auth.ts' } });
      activity('tool.end', { call_id: 'diff-preview', ok: true, diff: fixtureDiff });
      if (width !== 1440) await page.getByRole('tab', { name: 'Changes & PR', exact: true }).click();
      const diffCard = page.locator('[data-slot="card"]').filter({ has: page.getByRole('heading', { name: 'api/src/auth.ts', exact: true }) });
      await expect(diffCard.locator('.bg-diff-add-line')).toContainText('return "/agents/"');
      await expect(diffCard.locator('.bg-diff-del-line')).toContainText('return "/login"');
      await captureThemes('run-diff');
      if (width !== 1440) await page.getByRole('tab', { name: 'Transcript', exact: true }).click();

      // Keep this scroll regression on the mounted run and its existing socket:
      // no reloads, navigation, replacement DOM or synthetic transcript heights.
      {
        const scroller = page.locator('[data-run-scroller]');
        const content = page.locator('[data-run-content]');
        const composer = page.locator('[data-run-composer]');
        // Hidden means mounted but inaccessible, not display:none or unmounted.
        const bottomButton = page.locator('button[aria-label="Scroll to bottom"]');
        const visibleButton = page.getByRole('button', { name: 'Scroll to bottom', exact: true });
        const originalScroller = await scroller.elementHandle();
        const socketCount = sockets.length;
        const runURL = page.url();
        const navigations = [];
        const onNavigation = frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); };
        const gap = () => scroller.evaluate(el => Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop));
        const atBottom = () => expect.poll(gap, { timeout: 5000 }).toBeLessThanOrEqual(2);
        const hidden = async () => {
          await expect(bottomButton).toHaveCount(1);
          await expect(bottomButton).toHaveAttribute('aria-hidden', 'true');
          await expect(bottomButton).toHaveAttribute('tabindex', '-1');
          await expect(bottomButton).toHaveCSS('opacity', '0');
          await expect.poll(() => bottomButton.evaluate(el => el.disabled || !!el.closest('[inert]') || getComputedStyle(el).pointerEvents === 'none'), { timeout: 5000 }).toBe(true);
          await expect(visibleButton).toHaveCount(0);
        };
        const visible = async () => {
          await expect(visibleButton).toBeVisible();
          await expect(visibleButton).toBeEnabled();
          await expect(visibleButton).toHaveCSS('opacity', '1');
          const buttonBox = await visibleButton.boundingBox();
          const composerBox = await composer.boundingBox();
          expect(buttonBox.y + buttonBox.height).toBeLessThanOrEqual(composerBox.y - 8);
        };
        const scrollUp = async () => {
          const before = await scroller.evaluate(el => el.scrollTop);
          const box = await scroller.boundingBox();
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, -360);
          await expect.poll(async () => before - await scroller.evaluate(el => el.scrollTop), { timeout: 5000 }).toBeGreaterThan(120);
          await expect.poll(gap, { timeout: 5000 }).toBeGreaterThan(120);
          // mouse.wheel returns before compositor scrolling necessarily finishes.
          await expect.poll(async () => Math.abs(await scroller.evaluate(el => el.scrollTop) - Math.max(0, before - 360)), { timeout: 5000 }).toBeLessThanOrEqual(2);
          await visible();
        };
        const stream = async marker => {
          const before = await content.evaluate(el => el.getBoundingClientRect().height);
          activity('text.delta', { text: '\n\n' + Array.from({ length: 12 }, (_, i) => `${marker} paragraph ${i + 1}: Checking the run transcript, layout and follow-up controls.`).join('\n\n') });
          await expect(content).toContainText(`${marker} paragraph 12`);
          await expect.poll(() => content.evaluate(el => el.getBoundingClientRect().height), { timeout: 5000 }).toBeGreaterThan(before + 120);
        };
        const shot = async (state, theme) => {
          await capture(`run-scroll-${state}-${theme}`);
          mkdirSync('shots', { recursive: true });
          const image = screenshots.at(-1);
          writeFileSync(join('shots', image.name), Buffer.from(image.data, 'base64'));
        };
        page.on('framenavigated', onNavigation);
        try {
          await expect(scroller).toBeVisible();
          await expect(content).toBeVisible();
          await expect(composer).toBeVisible();
          // Enough actual Markdown to overflow even the wide, tall viewport.
          await stream('Scroll fixture');
          await scroller.evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
          await atBottom();
          await hidden();
          // The rest of onboarding reduces motion. Exercise smooth scrolling here.
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme });
            await resolvedTheme(theme, page, 'system');
            await scrollUp();
            await shot('visible', theme);
            await visibleButton.click({ timeout: 5000 });
            // New output during the smooth jump must not cancel resumed following.
            await stream(`Jump ${theme}`);
            await atBottom();
            await hidden();
            await shot('hidden', theme);

            const pinnedTop = await scroller.evaluate(el => el.scrollTop);
            await stream(`Pinned ${theme}`);
            await atBottom();
            expect(await scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(pinnedTop + 120);
            await hidden();

            await scrollUp();
            const unpinnedTop = await scroller.evaluate(el => el.scrollTop);
            await stream(`Unpinned ${theme}`);
            // Let resize observers and scheduled scroll work run before asserting
            // preservation; an immediate assertion could pass before a bad jump.
            await page.waitForTimeout(400);
            expect(Math.abs(await scroller.evaluate(el => el.scrollTop) - unpinnedTop)).toBeLessThanOrEqual(2);
            await visible();
            await visibleButton.click({ timeout: 5000 });
            await atBottom();
            await hidden();
          }
          expect(navigations).toEqual([]);
          expect(page.url()).toBe(runURL);
          expect(sockets.length).toBe(socketCount);
          expect(await scroller.evaluate((el, original) => el === original, originalScroller)).toBe(true);
        } finally {
          page.off('framenavigated', onNavigation);
          await originalScroller?.dispose();
          await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
          await resolvedTheme('dark', page, 'system');
        }
      }

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

      queuePosition = 2;
      await page.reload();
      await expect(page.getByText('Waiting for a free workspace (position 2 of 3)', { exact: true })).toBeVisible();
      const queuedRow = page.getByRole('listitem').filter({ hasText: 'Composer preview' });
      await expect(queuedRow.getByText('Queued', { exact: true })).toBeVisible();
      await expect(queuedRow.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await capture('queued-list-menu-closed');
      await queuedRow.getByRole('button', { name: 'Run actions', exact: true }).focus();
      await page.keyboard.press('Enter');
      const cancelItem = page.getByRole('menuitem', { name: 'Cancel', exact: true });
      await expect(cancelItem).toBeVisible();
      await expect(cancelItem).toBeFocused();
      await expect(page.getByRole('menuitem', { name: 'Stop', exact: true })).toHaveCount(0);
      await capture('queued-list-menu-open');
      const cancelled = page.waitForResponse(r => r.url() === fixtureRunURL + '/stop' && r.request().method() === 'POST');
      await page.keyboard.press('Enter');
      expect((await cancelled).status()).toBe(200);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.getByText('Waiting for a free workspace', { exact: false })).toHaveCount(0);

      for (const backend of ['claude-code', 'codex']) {
        retiredBackend = backend;
        const previousSockets = sockets.length;
        await page.goto(origin + '/agents/runs/composer-fixture');
        await expect.poll(() => sockets.length).toBe(previousSockets + 1);
        sockets.at(-1).send(JSON.stringify({ seq: 1, ts: Date.now(), type: 'text.delta', text: 'Preserved run history.' }));
        await agentHeaders();
        await capture('agent-label-retired-' + backend);
      }
      retiredBackend = undefined;

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
      await page.unroute(origin + '/api/v1/runs?*', listRoute);
      await page.unroute(fixtureRunURL + '/messages', messagesRoute);
      await page.unroute(fixtureRunURL + '/stop', stopRoute);
      await page.unroute(fixtureRunURL + '/ticket', ticketRoute);
      await page.unroute(fixtureRunURL + '/diff', diffRoute);
      await page.goto(origin + '/agents/settings');
    }
  };
  try {
    const documentResponse = await page.goto(origin + '/');
    expect(documentResponse.headers()['content-security-policy']).toBe("img-src 'self' data: blob:");
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
    await verifyTheme();
    if (!returning) {
      const categoryNames = ['Personal settings', 'Models', 'Security', 'People', 'Agent access', 'Account management'];
      await expect(page.getByRole('heading', { level: 2 })).toHaveText(categoryNames);
      for (const name of categoryNames) {
        const heading = page.getByRole('heading', { name, exact: true, level: 2 });
        await heading.scrollIntoViewIfNeeded();
        const category = page.getByRole('region', { name, exact: true });
        const firstCard = category.locator('[data-slot="card"]').first();
        await expect(firstCard.getByRole('heading', { level: 3 })).toBeVisible();
        const style = await heading.evaluate(element => ({ size: parseFloat(getComputedStyle(element).fontSize), color: getComputedStyle(element).color, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
        expect(style.size).toBeGreaterThanOrEqual(22);
        expect(style.color).toBe(await page.locator('body').evaluate(element => getComputedStyle(element).color));
        expect(style.right).toBeLessThanOrEqual(width);
        expect(Math.abs(style.left - (await firstCard.boundingBox()).x)).toBeLessThanOrEqual(1);
        // Three overviews cover the page; repeat screenshots after restart add
        // no coverage for layout that does not depend on persisted state.
        if (['Personal settings', 'Security', 'Account management'].includes(name)) await captureThemes('settings-category-' + name.toLowerCase().replaceAll(' ', '-'));
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
    if (!returning) {
      await verifyPagination({ page, expect, origin, capture });
      await verifyComposers();
    }
    if (!returning) {
      const meURL = origin + '/api/v1/me';
      const externalAvatar = async route => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({ response, json: { ...body, user: { ...body.user, image: 'https://www.gravatar.com/avatar/x' } } });
      };
      await page.route(meURL, externalAvatar);
      await page.reload();
      await greyAvatar(page.getByLabel('No profile photo', { exact: true }).filter({ visible: true }).last());
      await expect(page.locator('img[src*="gravatar"]')).toHaveCount(0);
      await capture('external-avatar-ignored');
      await page.unroute(meURL, externalAvatar);
      await page.reload();
      await greyAvatar(page.getByLabel('No profile photo', { exact: true }).filter({ visible: true }).last());
      await capture('account-grey-default');
      await verifyAccents();
    }
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
    await expect(page.getByRole('switch', { name: 'Open pull requests automatically', exact: true })).toBeVisible();
    await captureThemes('automations-switches');
    await capture('automations');
    await page.goto(origin + '/agents/plugins');
    await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible();
    await page.getByRole('link', { name: /GitHub Manage your GitHub connection/ }).click();
    await expect(page).toHaveURL(origin + '/agents/plugins/github');
    await expect(page.getByRole('heading', { name: 'GitHub', level: 1, exact: true })).toBeVisible();
    // The first account is an administrator: both connection cards belong here,
    // including before connecting GitHub and after restarting the service.
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Your connection', 'Shared connection']);
    await expect(page.getByRole('switch', { name: 'Use the shared GitHub connection for accounts without their own', exact: true })).toBeEnabled();
    await expect(page.getByText('No shared GitHub account connected', { exact: true })).toBeVisible();
    if (!returning) {
      await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toHaveCount(2);
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
    await expect(page).toHaveURL(origin + '/agents/plugins/github');
    const sharedFallback = page.getByRole('switch', { name: 'Use the shared GitHub connection for accounts without their own', exact: true });
    await expect(sharedFallback).not.toBeChecked();
    await expect(sharedFallback).toBeEnabled();
    for (const checked of [true, false]) {
      const saved = page.waitForResponse(response => response.url() === origin + '/api/v1/settings/github' && response.request().method() === 'PUT');
      await sharedFallback.press('Space');
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toEqual({ fallback: checked });
      await expect(sharedFallback).toBeEnabled();
      await expect(sharedFallback).toHaveAttribute('aria-checked', String(checked));
    }
    await expect(page.getByText('Administrators manage this connection for accounts without their own GitHub connection. When enabled, those accounts can use the shared connection or service credentials configured on this server.', { exact: true })).toBeVisible();
    await page.getByRole('heading', { name: 'Shared connection', exact: true }).scrollIntoViewIfNeeded();
    await captureThemes('github-admin-shared-switch');
    await page.goto(origin + '/agents/settings#oidc');
    await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Connect GitHub', exact: true })).toHaveCount(0);
    const singleSignOn = page.getByRole('switch', { name: 'Enable single sign-on', exact: true });
    await singleSignOn.scrollIntoViewIfNeeded();
    await expect(singleSignOn).toBeEnabled();
    await expect(singleSignOn).not.toBeChecked();
    await captureThemes('oidc-switch');
    await page.goto(origin + '/agents/settings#people-settings');
    await page.getByRole('heading', { name: 'People', level: 3, exact: true }).scrollIntoViewIfNeeded();
    await capture('people-role-actions');
    if (returning) {
      const memberContext = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const member = await memberContext.newPage();
      try {
        const signed = await member.request.post(origin + '/api/auth/sign-in/email', { headers: { Origin: origin }, data: { email: 'member@example.test', password: 'test-password-only-123456' } });
        expect(signed.status()).toBe(200);
        const memberTheme = await member.request.put(origin + '/api/v1/me/theme', { headers: { Origin: origin }, data: { theme: 'light' } });
        expect(memberTheme.status()).toBe(200);
        expect((await (await member.request.get(origin + '/api/v1/me')).json()).theme).toBe('light');
        expect((await (await page.request.get(origin + '/api/v1/me')).json()).theme).toBe('system');
        await member.goto(origin + '/agents/settings#connections');
        await expect(member).toHaveURL(origin + '/agents/plugins/github');
        await resolvedTheme('light', member);
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
      // Observe the app's real requests: a successful password check alone does not
      // guarantee hydration if the following session lookup is rate-limited.
      const signingIn = page.waitForResponse(r => r.url() === origin + '/api/auth/sign-in/email' && r.request().method() === 'POST');
      const gettingSession = page.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/get-session' && new URL(r.url()).origin === origin && r.request().method() === 'GET');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      expect((await signingIn).status()).toBe(200);
      expect((await gettingSession).status()).toBe(200);
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
    expect(externalRequests).toEqual([]);
    console.log(JSON.stringify({ passed: true, width, phase: process.env.PHASE, screenshots }));
  } catch (error) {
    await capture('failure').catch(() => {});
    console.log(JSON.stringify({ error: error.stack || error.message, diagnostics: { errors, authResponses }, screenshots }));
  } finally {
    await browser.close(); await new Promise(resolve => provider.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
