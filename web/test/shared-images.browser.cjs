// Production transcript/fold/components with an in-memory owner-image PNG fixture.
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { chromium, expect } = require('@playwright/test');
let server, browser, origin;
before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ root: resolve(__dirname, '..'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  mkdirSync('/tmp/gond-shared-images', { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`shared image: caption, keyboard enlarge, local-path note, privacy at ${width} ${theme}`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [], unwanted = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/example\.test|\/tmp\/mobile\.png/.test(request.url())) unwanted.push(request.url()); });
    try {
      await page.goto(`${origin}/agents/test/fixtures/shared-images.html?theme=${theme}`);
      const trigger = page.getByRole('button', { name: 'Enlarge image: Desktop Home pagination — 10 runs per page' });
      await expect(trigger).toBeVisible();
      await expect(trigger.getByRole('img')).toHaveAttribute('alt', 'Desktop Home pagination — 10 runs per page');
      await expect(page.locator('figcaption')).toHaveText('Desktop Home pagination — 10 runs per page');
      await expect(page.getByText('image not available (local path)', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Remote screenshot' })).toHaveAttribute('href', 'https://example.test/private.png');
      await expect(page.locator('img[src="/tmp/mobile.png"], img[src^="https:"]')).toHaveCount(0);
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(trigger).toBeFocused();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
      await page.screenshot({ path: `/tmp/gond-shared-images/transcript-${width}-${theme}.png`, fullPage: true });
      assert.deepEqual(errors, []); assert.deepEqual(unwanted, []);
    } finally { await page.close(); }
  });
}
test('no-store tool images and reply cards reuse blobs through expansion, focus and transcript remount', async () => {
  const page = await browser.newPage();
  const requests = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/v1/runs/fixture/images/*', async route => {
    requests.push(route.request().url().split('/').pop());
    await route.fulfill({ status: 200, headers: {
      'content-type': 'image/png', 'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox',
    }, body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6p8AAAAASUVORK5CYII=', 'base64') });
  });
  try {
    await page.goto(`${origin}/agents/test/fixtures/shared-images.html?network=1`);
    const card = page.getByRole('button', { name: 'Enlarge image: Desktop Home pagination — 10 runs per page' });
    const tool = page.getByRole('button', { name: 'Browser checks finished' });
    await expect(card).toBeVisible();
    await expect(page.getByRole('img', { name: 'Attached image', exact: true })).toBeVisible();
    for (let i = 0; i < 2; i++) {
      await tool.click();
      await expect(page.getByRole('img', { name: 'Wide browser screenshot' })).toBeVisible();
      await tool.click();
      await expect(page.getByRole('img', { name: 'Wide browser screenshot' })).not.toBeVisible();
      await card.click();
      await expect(page.getByRole('dialog').getByRole('img')).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: 'Toggle transcript' }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: 'Toggle transcript' }).click();
    await expect(card).toBeVisible();
    await tool.click();
    await expect(page.getByRole('img', { name: 'Wide browser screenshot' })).toBeVisible();
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(requests.sort(), ['img_fixture', 'img_tool'], 'one GET per image despite no-store');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
