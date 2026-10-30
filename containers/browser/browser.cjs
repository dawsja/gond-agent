// One fresh context per viewport. Docker is the containment boundary; never run this on the host.
const { chromium, expect } = require('@playwright/test');

async function run(input) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const results = [];
  try {
    for (const viewport of [{ name: 'wide', width: 1440, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.name === 'phone', deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.setDefaultNavigationTimeout(30000);
      const errors = [];
      const addError = (s) => { if (errors.length < 20) errors.push(String(s).slice(0, 500)); };
      page.on('pageerror', (e) => addError(e.message));
      page.on('console', (m) => { if (m.type() === 'error') addError(m.text()); });
      page.on('requestfailed', (r) => addError(`${r.method()} ${r.url()}: ${r.failure()?.errorText}`));
      page.on('response', (r) => { if (r.status() >= 400) addError(`HTTP ${r.status()} ${r.url()}`); });
      const result = { viewport, ok: false, errors };
      try {
        const response = await page.goto(input.url, { waitUntil: 'domcontentloaded' });
        if (!response?.ok()) throw new Error(`Navigation failed: HTTP ${response?.status() ?? 'unknown'}`);
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        await new AsyncFunction('page', 'expect', input.script)(page, expect);
        await page.evaluate(() => document.fonts.ready);
        result.title = await page.title();
        result.ok = errors.length === 0;
      } catch (e) {
        addError(e.message);
      } finally {
        try { result.image = (await page.screenshot({ type: 'jpeg', quality: 70, timeout: 10000 })).toString('base64'); }
        catch (e) { result.ok = false; addError(`Screenshot failed: ${e.message}`); }
        result.ok = result.ok && errors.length === 0;
        results.push(result);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { ok: results.length === 2 && results.every((r) => r.ok), results };
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (s) => { input += s; if (input.length > 40000) process.exit(1); });
  process.stdin.on('end', async () => {
    try { process.stdout.write(JSON.stringify(await run(JSON.parse(input)))); }
    catch { process.exitCode = 1; }
  });
}
module.exports = { run };
