// Runs inside the worker image against the real packaged service, never API/browser mocks.
const { chromium, expect } = require('@playwright/test');
const { createServer } = require('node:http');
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
    await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
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
