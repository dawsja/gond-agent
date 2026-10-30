// Runs inside the worker image against the real packaged service, never API/browser mocks.
const { chromium, expect } = require('@playwright/test');
const { createServer } = require('node:http');
const { writeFileSync, unlinkSync } = require('node:fs');
const width = Number(process.env.WIDTH);
const origin = 'http://gond-agent:8787';
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
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
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
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      await page.getByLabel('Connection name', { exact: true }).fill('Fixture provider');
      await page.getByLabel('API format', { exact: true }).selectOption('anthropic');
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue('https://api.anthropic.com/v1');
      await page.getByLabel('API format', { exact: true }).selectOption('openai-responses');
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue('https://api.openai.com/v1');
      await page.getByLabel('API base URL', { exact: true }).fill('http://provider-fixture:3030/v1');
      await page.getByLabel('API format', { exact: true }).selectOption(width === 1440 ? 'anthropic' : 'openai-responses');
      await expect(page.getByLabel('API base URL', { exact: true })).toHaveValue('http://provider-fixture:3030/v1');
      await page.getByLabel('API key', { exact: true }).fill(key);
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      await page.getByLabel('Connection name', { exact: true }).nth(1).fill('Second provider');
      await page.getByLabel('API base URL', { exact: true }).nth(1).fill('http://provider-fixture:3030/second/v1');
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
    if (width === 1440) {
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      const expand = page.getByRole('button', { name: 'Expand sidebar', exact: true });
      await page.mouse.move(500, 300);
      await expect(expand.locator('svg').last()).toHaveCSS('opacity', '0');
      await expect(expand.locator('svg').first()).toHaveCSS('opacity', '1');
      await expand.hover();
      await expect(expand.locator('svg').last()).toHaveCSS('opacity', '1');
      await expect(page.getByRole('tooltip')).toHaveText('Expand sidebar');
      await capture('sidebar-logo-hover');
      for (const name of ['New agent', 'Search', 'Home', 'Usage', 'Plugins', 'Automations', 'Settings']) {
        const target = ['Home', 'Usage', 'Plugins', 'Automations', 'Settings'].includes(name) ? page.getByRole('link', { name, exact: true }) : page.getByRole('button', { name, exact: true }).first();
        await target.hover();
        await expect(page.getByRole('tooltip')).toHaveText(name);
      }
      await capture('sidebar-tooltip');
      await page.getByRole('button', { name: 'Account menu', exact: true }).hover();
      await expect(page.getByRole('tooltip')).toHaveText('Account');
      await page.getByRole('button', { name: 'Account menu', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Documentation', exact: true })).toBeVisible();
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
    const accountTrigger = page.getByRole('button', { name: 'Account menu', exact: true }).filter({ visible: true });
    const accountWidth = (await accountTrigger.boundingBox()).width;
    await accountTrigger.click();
    await expect(page.getByRole('menuitem', { name: 'Documentation', exact: true })).toHaveAttribute('href', 'https://gond.io/agent/docs');
    await expect(page.getByRole('menuitem', { name: 'Sign out', exact: true })).toBeVisible();
    const menuWidth = (await page.getByRole('menu').boundingBox()).width;
    expect(Math.abs(menuWidth - accountWidth)).toBeLessThanOrEqual(1);
    await capture('account-menu');
    await page.keyboard.press('Escape');
    if (width !== 1440) await page.keyboard.press('Escape');
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
    if (!returning) {
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      const manual = page.locator('fieldset').nth(2);
      await manual.getByLabel('Connection name', { exact: true }).fill('Manual provider');
      await manual.getByLabel('API format', { exact: true }).selectOption(width === 1440 ? 'anthropic' : 'openai-responses');
      await manual.getByLabel('API base URL', { exact: true }).fill('http://provider-fixture:3030/unsupported/v1');
      await manual.getByLabel('API key', { exact: true }).fill(key);
      await manual.getByText('Advanced model overrides (optional)', { exact: true }).click();
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
    await capture('settings-' + (process.env.PHASE || 'bootstrap'));
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
      writeFileSync('/fixture/fail', 'yes');
      await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
      await expect(page.getByText(/GitHub sign-in didn't finish/)).toBeVisible();
      await capture('github-login-error');
      unlinkSync('/fixture/fail');
      await page.getByRole('button', { name: 'Sign in to GitHub', exact: true }).click();
      await expect(page.getByLabel('One-time code', { exact: true })).toHaveValue('ABCD-1234');
      writeFileSync('/fixture/approve', 'yes');
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
    expect(errors).toEqual([]);
    console.log(JSON.stringify({ passed: true, width, phase: process.env.PHASE, screenshots }));
  } catch (error) {
    await capture('failure').catch(() => {});
    console.log(JSON.stringify({ error: error.message, screenshots }));
  } finally {
    await browser.close(); await new Promise(resolve => provider.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
