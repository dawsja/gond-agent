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
  const capture = async name => screenshots.push({ name: `${name}-${width}.png`, data: (await page.screenshot({ fullPage: true })).toString('base64') });
  const settingsURL = origin + '/api/v1/settings/providers';
  const save = async button => {
    const response = page.waitForResponse(r => r.url() === settingsURL && r.request().method() === 'PUT');
    await page.getByRole('button', { name: button, exact: true }).click();
    return response;
  };
  const selectFormat = async (scope, format) => {
    await scope.getByLabel('Provider type', { exact: true }).selectOption(format === 'anthropic' ? 'anthropic' : 'openai');
    if (format !== 'anthropic') {
      await scope.getByText('Advanced settings (optional)', { exact: true }).click();
      await scope.getByLabel('OpenAI API protocol', { exact: true }).selectOption(format);
      await scope.getByText('Advanced settings (optional)', { exact: true }).click();
    }
  };
  // UI fixtures exercise API and subscription choices without a paid model call.
  // Registration, provider setup, storage and the rest of onboarding use the real service.
  const verifyComposers = async () => {
    const efforts = ['low', 'medium', 'high'];
    const models = [
      { id: 'fixture:gpt-5.4', display_name: 'GPT-5.4 · API', provider: 'openai', efforts },
      { id: 'fixture:claude-sonnet-4-6', display_name: 'Claude Sonnet · API', provider: 'anthropic', efforts },
      { id: 'cli-codex:default', display_name: 'Codex · Subscription', provider: 'openai', backend: 'codex', efforts },
      { id: 'cli-claude-code:sonnet', display_name: 'Sonnet · Subscription', provider: 'anthropic', backend: 'claude-code', efforts },
    ].map(model => ({ ...model, context_window: 200000 }));
    const catalogURL = origin + '/api/v1/models';
    const fixtureRunURL = origin + '/api/v1/runs/composer-fixture';
    let current = models[0], sent;
    const run = () => ({ id: 'composer-fixture', user_id: 'fixture', repo: 'acme/app', base_branch: 'main', branch: 'fixture', model_id: current.id, backend: current.backend, effort: 'medium', title: 'Composer preview', prompt: 'Review the settings', status: 'ready', files: 0, additions: 0, deletions: 0, created_at: Date.now(), updated_at: Date.now(), live: { phase: 'idle' } });
    const modelRoute = route => route.fulfill({ json: { models, connections: [] } });
    const runRoute = route => route.fulfill({ json: run() });
    const messagesRoute = route => { sent = route.request().postDataJSON(); return route.fulfill({ json: { ok: true } }); };
    const ticketRoute = route => route.fulfill({ json: { ticket: 'composer-fixture' } });
    const diffRoute = route => route.fulfill({ body: '' });
    await page.route(catalogURL, modelRoute);
    await page.route(fixtureRunURL, runRoute);
    await page.route(fixtureRunURL + '/messages', messagesRoute);
    await page.route(fixtureRunURL + '/ticket', ticketRoute);
    await page.route(fixtureRunURL + '/diff', diffRoute);
    await page.routeWebSocket('**/ws/runs/composer-fixture?*', socket => socket.onMessage(() => {}));
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
        await layout('Choose model');
        await page.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Search thinking levels', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'High', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Reasoning effort', exact: true })).toHaveText('High');
      }
      await page.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
      await capture('thinking-menu');
      await page.keyboard.press('Escape');
      for (const model of models) {
        current = model;
        await page.goto(origin + '/agents/runs/composer-fixture');
        const picker = page.getByRole('button', { name: 'Follow-up model', exact: true });
        await expect(picker).toContainText(model.display_name);
        await expect(picker.locator('[data-model-provider]')).toHaveAttribute('data-model-provider', model.provider);
        await layout('Follow-up model');
        await picker.click();
        for (const other of models.filter(item => item.backend !== model.backend)) {
          await expect(page.getByRole('button', { name: other.display_name, exact: true })).toHaveCount(0);
        }
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: 'Reasoning effort', exact: true }).click();
        await page.getByRole('button', { name: 'Low', exact: true }).click();
        await page.getByRole('textbox', { name: 'Follow-up message', exact: true }).fill('Check the settings layout');
        const response = page.waitForResponse(fixtureRunURL + '/messages');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        await response;
        expect(sent.effort).toBe('low');
        await capture('follow-up-' + (model.backend ?? model.provider));
      }
    } finally {
      await page.unroute(catalogURL, modelRoute);
      await page.unroute(fixtureRunURL, runRoute);
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
      expect(await page.getByRole('heading', {name: 'Subscription agents', exact: true}).evaluate(element => element.closest('section').nextElementSibling.querySelector('h2').textContent)).toBe('Connect your models');
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      await page.getByLabel('Connection name', { exact: true }).fill('Fixture provider');
      await expect(page.getByLabel('Provider type', { exact: true }).locator('option')).toHaveText(['OpenAI Compatible API', 'Anthropic']);
      await expect(page.getByLabel('OpenAI API protocol', { exact: true })).toBeHidden();
      await selectFormat(page, 'anthropic');
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue('https://api.anthropic.com/v1');
      await selectFormat(page, 'openai-responses');
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue('https://api.openai.com/v1');
      await page.getByLabel('API base URL', { exact: true }).fill(providerOrigin + '/v1');
      await selectFormat(page, width === 1440 ? 'anthropic' : 'openai-responses');
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue(providerOrigin + '/v1');
      await page.getByLabel('API key', { exact: true }).fill(key);
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      await page.getByLabel('Connection name', { exact: true }).nth(1).fill('Second provider');
      await page.getByLabel('API base URL', { exact: true }).nth(1).fill(providerOrigin + '/second/v1');
      await page.getByLabel('API key', { exact: true }).nth(1).fill(key + '-second');
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
    await expect(page.getByRole('link', { name: 'Documentation', exact: true })).toHaveCount(0);
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
      await expect(page.getByRole('menuitem', { name: 'Documentation', exact: true })).toHaveCount(0);
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
    await expect(page.getByRole('menuitem', { name: 'Documentation', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
    const menuWidth = (await page.getByRole('menu').boundingBox()).width;
    expect(Math.abs(menuWidth - accountWidth)).toBeLessThanOrEqual(1);
    await capture('account-menu');
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(origin + '/agents/settings');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    expect(await page.locator('#subscription-agents').evaluate(element => element.nextElementSibling.id)).toBe('providers');
    await page.goto(origin + '/agents/');
    if (width !== 1440) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Search', exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole('option', { name: 'Gond Agent Docs', exact: true })).toHaveCount(0);
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
    await expect(page.getByLabel('Connection name', { exact: true }).first()).toHaveValue('Fixture provider');
    await expect(page.getByLabel('API key', { exact: true }).first()).toHaveValue('');
    await expect(page.getByLabel('API key', { exact: true }).first()).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
    const firstProvider = page.locator('#providers fieldset').first();
    await expect(firstProvider.getByLabel('Provider type', { exact: true })).toHaveValue(width === 1440 ? 'anthropic' : 'openai');
    if (width !== 1440) {
      await firstProvider.getByText('Advanced settings (optional)', { exact: true }).click();
      await expect(firstProvider.getByLabel('OpenAI API protocol', { exact: true })).toHaveValue('openai-responses');
      await firstProvider.getByText('Advanced settings (optional)', { exact: true }).click();
    }
    if (!returning) {
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      const manual = page.locator('fieldset').nth(2);
      await manual.getByLabel('Connection name', { exact: true }).fill('Manual provider');
      await selectFormat(manual, width === 1440 ? 'anthropic' : 'openai-responses');
      await manual.getByLabel('API base URL', { exact: true }).fill(providerOrigin + '/unsupported/v1');
      await manual.getByLabel('API key', { exact: true }).fill(key);
      await manual.getByText('Advanced settings (optional)', { exact: true }).click();
      await manual.getByRole('button', { name: 'Add manual model', exact: true }).click();
      await manual.getByLabel('Model ID', { exact: true }).fill('manual-model');
      expect((await save('Save provider settings')).status()).toBe(200);
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
      await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
      await expect(page.getByLabel('One-time code', { exact: true })).toHaveValue('ABCD-1234');
      await expect(page.getByRole('link', { name: 'Continue on GitHub', exact: true })).toHaveAttribute('href', 'https://github.com/login/device');
      await capture('github-device-login');
      await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
      await expect(page.getByText('GitHub sign-in cancelled.', { exact: true })).toBeVisible();
      await expect(page.getByLabel('One-time code', { exact: true })).toHaveCount(0);
      writeFileSync(join(fixtureDir, 'fail'), 'yes');
      await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
      await expect(page.getByText(/GitHub sign-in didn't finish/)).toBeVisible();
      await capture('github-login-error');
      unlinkSync(join(fixtureDir, 'fail'));
      await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
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
      await page.locator('#subscription-agents').scrollIntoViewIfNeeded();
      await expect(page.getByText('Subscription agents', { exact: true })).toBeVisible();
      await expect(page.getByText('Claude Code', { exact: true })).toBeVisible();
      await expect(page.getByText('Codex', { exact: true })).toBeVisible();
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
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      await page.getByLabel('Connection name', { exact: true }).fill('Fresh provider');
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
