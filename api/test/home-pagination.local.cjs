// npm run build in web/ first. Uses the installed worker browser runtime, no Docker.
// NODE_PATH=/opt/gond-agent-browser/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/gond-agent-browser/browsers node api/test/home-pagination.local.cjs /tmp/home-pagination
require('tsx/cjs');
const { startPaginationServer } = require('./home-pagination-server.ts');
const { chromium, expect } = require('@playwright/test');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { verifyPagination } = require('./home-pagination.browser.cjs');
const output = process.argv[2] || '/tmp/home-pagination';
(async () => {
  mkdirSync(output, { recursive: true });
  const server = await startPaginationServer();
  const origin = server.origin;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: 'dark', reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const user = { id: 'fixture', name: 'Pagination', email: 'fixture@example.test' };
      await page.route(origin + '/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        let json = {};
        if (path === '/api/auth/get-session') json = { user, session: { id: 'fixture', userId: user.id, token: 'fixture-session', expiresAt: '2099-01-01T00:00:00Z', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
        else if (path === '/api/v1/me') json = { user, theme: 'system', accent: 'blue', setup_required: false, admin: false, automations: { auto_pr: false } };
        else if (path === '/api/v1/models') json = { models: [{ id: 'fixture:coder', provider: 'openai', display_name: 'Fixture coder', context_window: 128000 }], connections: [] };
        else if (path === '/api/v1/github') json = { configured: false, login: null, managed: false };
        else if (path.endsWith('/repos')) json = { repos: [] };
        else if (path.endsWith('/subscriptions')) json = { providers: [], accounts: [], pending: null, welcome: false };
        else if (path.endsWith('/tokens')) json = { tokens: [] };
        else if (path.endsWith('/accounts')) json = { accounts: [] };
        else if (path.endsWith('/runs')) json = { runs: [] };
        return route.fulfill({ json });
      });
      try {
        await verifyPagination({ page, expect, origin, capture: async name => {
          const path = join(output, `${name}-${width}.png`);
          await page.screenshot({ path, animations: 'disabled' });
          console.log(path);
        } });
        expect(errors).toEqual([]);
        console.log(JSON.stringify({ passed: true, width }));
      } catch (error) {
        await page.screenshot({ path: join(output, `failure-${width}.png`) });
        console.error(JSON.stringify({ width, errors, url: page.url() }));
        throw error;
      } finally { await page.close(); }
    }
  } finally { await browser.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
