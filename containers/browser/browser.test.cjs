const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { run } = require('./browser.cjs');

test('real Chromium: interactions, two screenshots, assertion and console failures', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Browser fixture</title><button onclick="this.textContent=\'Saved\'">Save</button>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const good = await run({ url, script: "await page.getByRole('button', {name:'Save', exact:true}).click(); await expect(page.getByRole('button')).toHaveText('Saved');" });
    assert.equal(good.ok, true);
    assert.deepEqual(good.results.map((r) => r.viewport.name), ['wide', 'phone']);
    for (const r of good.results) assert.ok(Buffer.from(r.image, 'base64').length > 100);
    const bad = await run({ url, script: "await expect(page.getByRole('button')).toHaveText('Wrong', {timeout:100});" });
    assert.equal(bad.ok, false);
    assert.ok(bad.results.every((r) => r.errors.length > 0 && r.image));
    const error = await run({ url, script: "await page.evaluate(() => console.error('broken flow'));" });
    assert.equal(error.ok, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
