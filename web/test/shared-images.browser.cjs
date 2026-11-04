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
