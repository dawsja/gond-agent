// Runs inside the worker image against the real packaged service, never API/browser mocks.
const { chromium, expect } = require('@playwright/test');
const { createServer } = require('node:http');
const width = Number(process.env.WIDTH);
const origin = 'http://gond-agent:8787';
const screenshots = [];
const key = 'fixture-only-provider-key';

(async () => {
  const provider = createServer((req, res) => {
    if (req.url !== '/v1/models' || req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(403).end(); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
  });
  await new Promise(resolve => provider.listen(0, '0.0.0.0', resolve));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const capture = async name => screenshots.push({ name: `${name}-${width}.png`, data: (await page.screenshot({ fullPage: true })).toString('base64') });
  try {
    await page.goto(origin + '/');
    await expect(page).toHaveURL(origin + '/agents/');
    expect(await page.evaluate(() => ({ secure: isSecureContext, uuid: typeof crypto.randomUUID }))).toEqual({ secure: false, uuid: 'undefined' });
    if (process.env.PHASE === 'returning') {
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
    await page.getByRole('button', { name: process.env.PHASE === 'returning' ? 'Sign in' : 'Create administrator account', exact: true }).click();
    if (process.env.PHASE !== 'returning') {
      await expect(page.getByRole('heading', { name: 'Set up Gond Agent', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      await expect(page.getByLabel('Connection name', { exact: true })).toHaveCount(1);
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      await expect(page.getByLabel('Connection name', { exact: true })).toHaveCount(2);
      await page.getByRole('button', { name: 'Remove provider', exact: true }).nth(1).click();
      await page.getByLabel('Connection name', { exact: true }).fill('Fixture provider');
      await page.getByLabel('API base URL', { exact: true }).fill(`http://provider-fixture:${provider.address().port}/v1`);
      await page.getByLabel('API key', { exact: true }).fill(key);
      await page.getByLabel('Model ID', { exact: true }).fill('fixture-model');
      await capture('provider-setup');
      const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/settings/providers') && response.request().method() === 'PUT');
      await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
      const response = await saved;
      expect(response.status()).toBe(200);
      const settings = await response.json();
      expect(settings.connections[0].hasKey).toBe(true);
      expect(JSON.stringify(settings)).not.toContain(key);
    }
    await expect(page.getByRole('heading', { level: 1 })).toContainText(', Test');
    const me = await (await page.request.get(origin + '/api/v1/me')).json();
    expect(me.admin).toBe(true);
    expect(me.setup_required).toBe(false);
    await capture(process.env.PHASE === 'returning' ? 'workspace-after-restart' : 'workspace');
    await page.goto(origin + '/agents/settings');
    await expect(page.getByLabel('Connection name', { exact: true })).toHaveValue('Fixture provider');
    await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
    await expect(page.getByLabel('API key', { exact: true })).toHaveAttribute('placeholder', 'Saved — leave blank to keep');
    if (process.env.PHASE !== 'returning') {
      await page.getByRole('button', { name: 'Test saved connection', exact: true }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Connected.' })).toBeVisible();
      await page.getByRole('button', { name: 'Add provider', exact: true }).click();
      await expect(page.getByLabel('Connection name', { exact: true })).toHaveCount(2);
      await page.getByRole('button', { name: 'Remove provider', exact: true }).nth(1).click();
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
    await browser.close();
    await new Promise(resolve => provider.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
