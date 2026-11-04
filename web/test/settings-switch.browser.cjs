// Real React/Radix components and styles, with same-origin API route fixtures.
// Run: npm exec --call 'node --test test/settings-switch.browser.cjs' (from web/).
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { chromium, expect } = require('@playwright/test');
let server, browser, origin, settingsRegistry;
const settingsScreenshots = '/tmp/gond-settings-pages';
const screenshots = process.env.SCREENSHOT_DIR || '/tmp/gond-settings-switches';
const fallbackLabel = 'Use the shared GitHub connection for accounts without their own';
const fixture = (view, theme = 'light', accent = 'blue') => `${origin}/agents/test/fixtures/settings-switch.html?view=${view}&theme=${theme}&accent=${accent}`;
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ root: resolve(__dirname, '..'), server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  mkdirSync(screenshots, { recursive: true });
  mkdirSync(settingsScreenshots, { recursive: true });
  settingsRegistry = await import('../src/features/settings/registry.ts');
});
after(async () => { await browser?.close(); await server?.close(); });

async function mockAPI(page, theme = 'light', { admin = true, connected = false } = {}) {
  const state = { accent: 'blue', theme, fallback: false, auto_pr: true, enabled: true, puts: [], personal: connected, shared: connected, login: { status: 'idle' }, sharedLogin: { status: 'idle' }, requests: [] };
  const user = { id: admin ? 'admin' : 'member', name: admin ? 'Test Administrator' : 'Test Member', email: admin ? 'admin@example.test' : 'member@example.test' };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    state.requests.push({ path, method: request.method() });
    if (path.endsWith('/github/login') && request.method() !== 'GET') {
      const key = path.includes('/settings/') ? 'sharedLogin' : 'login';
      if (request.method() === 'DELETE') assert.deepEqual(request.postDataJSON(), { id: 'fixture-flow' });
      state[key] = request.method() === 'POST' ? { id: 'fixture-flow', status: 'pending', code: 'ABCD-1234' } : { status: 'cancelled' };
      return route.fulfill({ json: state[key] });
    }
    if (path.endsWith('/github') && request.method() === 'DELETE') {
      state[path.includes('/settings/') ? 'shared' : 'personal'] = false;
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === 'PUT') {
      const body = request.postDataJSON();
      state.puts.push({ path, body });
      if (path === '/api/v1/settings/github') state.fallback = body.fallback;
      else if (path === '/api/v1/me/automations') state.auto_pr = body.auto_pr;
      else if (path === '/api/v1/me/accent') { state.accent = body.accent; return route.fulfill({ json: { accent: state.accent } }); }
      else if (path === '/api/v1/me/theme') state.theme = body.theme;
      else if (path.endsWith('/enabled')) state.enabled = body.enabled;
      else if (path !== '/api/v1/settings/oidc') throw new Error(`Unexpected mutation ${path}`);
      return route.fulfill({ json: { ok: true } });
    }
    const responses = {
      '/api/auth/get-session': { session: { id: 'fixture-session', userId: user.id, expiresAt: new Date(Date.now() + 86400000).toISOString() }, user },
      '/api/v1/me': { theme: state.theme, accent: state.accent, admin, user, setup_required: false, automations: { auto_pr: state.auto_pr } },
      '/api/v1/me/deletion': { last_account: true, has_password: true, blocked_reason: null },
      '/api/v1/runs': { runs: [] },
      '/api/v1/subscriptions': { accounts: [], pending: null, welcome: false },
      '/api/v1/settings/providers': { connections: [], defaultModel: '' },
      '/api/v1/me/sign-in-methods': { methods: [{ id: 'password', provider: 'credential' }], providers: [] },
      '/api/v1/settings/oidc': { enabled: false, name: 'Single sign-on', issuer: 'https://identity.example.test', clientId: 'example', hasSecret: true, callbackURL: 'https://workspace.example.test/api/auth/oauth2/callback/oidc' },
      '/api/v1/sessions': { sessions: [], currentToken: '' },
      '/api/v1/github': { configured: state.personal, managed: state.personal, login: state.personal ? 'personal-user' : null },
      '/api/v1/settings/github': { configured: state.shared, managed: state.shared, login: state.shared ? 'shared-user' : null, fallback: state.fallback },
      '/api/v1/github/login': state.login,
      '/api/v1/settings/github/login': state.sharedLogin,
      '/api/v1/settings/people': { people: [] },
      '/api/v1/settings/web-search': { provider: 'none', hasKey: false, configured: false },
      '/api/v1/mcp/tokens': { endpoint: 'https://workspace.example.test/mcp', tokens: [] },
      '/api/v1/runners': { runners: [{ id: 'daily', name: 'Daily review', prompt: 'Review open work', repo: 'acme/app', frequency: 'daily', weekdays: [], minute: 540, timezone: 'UTC', enabled: state.enabled, next_run_at: null, last: null }] },
    };
    if (!(path in responses)) throw new Error(`Unexpected request ${path}`);
    await route.fulfill({ json: responses[path] });
  });
  return state;
}

async function withPage(options, body) {
  const page = await browser.newPage({ reducedMotion: 'reduce', ...options });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try { await body(page); assert.deepEqual(errors, []); } finally { await page.close(); }
}

test('shared Switch: click, Space/Enter, aria, label, focus order, disabled/pending and no form submit', async () => {
  await withPage({}, async page => {
    await page.goto(fixture('component'));
    const control = page.getByRole('switch', { name: 'Example setting', exact: true });
    await expect(control).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Before', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS('outline-style', 'none');
    assert.notEqual(await control.evaluate(el => getComputedStyle(el).boxShadow), 'none', 'visible keyboard focus ring');
    await control.press('Space');
    await expect(control).toBeChecked();
    await control.press('Enter');
    await expect(control).not.toBeChecked();
    await control.click();
    await expect(control).toBeChecked();
    await page.getByText('Example setting', { exact: true }).click();
    await expect(control).not.toBeChecked();
    await control.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Simulate pending' })).toBeFocused();
    const disabled = page.getByRole('switch', { name: 'Disabled setting' });
    await expect(disabled).toBeDisabled();
    await disabled.dispatchEvent('click');
    await expect(disabled).not.toBeChecked();
    await page.getByRole('button', { name: 'Simulate pending' }).click();
    await expect(control).toBeDisabled();
    await expect(control).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('status').filter({ hasText: 'Saving…' })).toHaveCount(1);
    await control.dispatchEvent('click');
    await expect(control).not.toBeChecked();
    await page.getByRole('button', { name: 'Simulate pending' }).click();
    await expect(control).toBeEnabled();
    await expect(control).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('status').filter({ hasText: 'Saving…' })).toHaveCount(0);
    await expect(page.getByLabel('Form submissions')).toHaveText('0');
  });
});

test('GitHub row preserves PUT body/endpoint, updates optimistically, blocks duplicates and rolls back errors', async () => {
  await withPage({}, async page => {
    const state = await mockAPI(page);
    await page.goto(origin + '/agents/plugins/github');
    const control = page.getByRole('switch', { name: fallbackLabel, exact: true });
    await expect(control).toBeEnabled();
    await expect(control).not.toBeChecked();
    for (const success of [true, false]) {
      const hold = deferred();
      let requests = 0;
      await page.route('**/api/v1/settings/github', async route => {
        if (route.request().method() !== 'PUT') return route.fallback();
        requests++;
        assert.deepEqual(route.request().postDataJSON(), { fallback: success });
        await hold.promise;
        if (success) { state.fallback = true; await route.fulfill({ json: { ok: true } }); }
        else await route.fulfill({ status: 500, json: { error: { code: 'fixture_failure', message: "Couldn't save the shared connection. Try again." } } });
      });
      try {
        await control.click();
        await expect(control).toHaveAttribute('aria-checked', String(success));
        await expect(control).toBeDisabled();
        await expect(control).toHaveAttribute('aria-busy', 'true');
        await expect(page.getByRole('status').filter({ hasText: 'Saving…' })).toHaveCount(1);
        await control.dispatchEvent('click');
        await expect.poll(() => requests).toBe(1);
      } finally { hold.release(); }
      await expect(control).toBeEnabled();
      await expect(control).toBeChecked();
      assert.equal(requests, 1);
    }
    await expect(page.getByRole('alert')).toHaveText("Couldn't save the shared connection. Try again.");
    // A reload uses the successfully saved value, never the failed optimistic one.
    await page.reload();
    await expect(control).toBeChecked();
  });
});

test('OIDC switch remains a draft until explicit Save and announces/blocks while saving', async () => {
  await withPage({}, async page => {
    const state = await mockAPI(page);
    await page.goto(fixture('settings'));
    const control = page.getByRole('switch', { name: 'Enable single sign-on' });
    await control.click();
    await expect(control).toBeChecked();
    assert.equal(state.puts.length, 0, 'toggling must not submit the form');
    const hold = deferred();
    let body;
    await page.route('**/api/v1/settings/oidc', async route => {
      if (route.request().method() !== 'PUT') return route.fallback();
      body = route.request().postDataJSON();
      await hold.promise;
      await route.fulfill({ json: { ok: true } });
    });
    try {
      await page.getByRole('button', { name: 'Save sign-in settings' }).click();
      await expect(control).toBeDisabled();
      await expect(control).toHaveAttribute('aria-busy', 'true');
      await expect.poll(() => body?.enabled).toBe(true);
    } finally { hold.release(); }
    await expect(control).toBeEnabled();
    await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  });
});

test('automatic PR and schedule switches show pending values and restore them after failed saves', async () => {
  await withPage({}, async page => {
    await mockAPI(page);
    await page.goto(fixture('automations'));
    for (const [name, path, expectedBody] of [
      ['Open pull requests automatically', '/api/v1/me/automations', { auto_pr: false }],
      ['Enable Daily review', '/api/v1/runners/daily/enabled', { enabled: false }],
    ]) {
      const control = page.getByRole('switch', { name, exact: true });
      const hold = deferred();
      let requests = 0;
      await page.route(`**${path}`, async route => {
        requests++;
        assert.equal(route.request().method(), 'PUT');
        assert.deepEqual(route.request().postDataJSON(), expectedBody);
        await hold.promise;
        await route.fulfill({ status: 500, json: { error: { message: "Couldn't save. Try again." } } });
      });
      try {
        await expect(control).toBeChecked();
        await control.click();
        await expect(control).not.toBeChecked();
        await expect(control).toBeDisabled();
        await expect(control).toHaveAttribute('aria-busy', 'true');
        await control.dispatchEvent('click');
        await expect.poll(() => requests).toBe(1);
      } finally { hold.release(); }
      await expect(control).toBeEnabled();
      await expect(control).toBeChecked();
      await expect(page.getByRole('alert').filter({ hasText: "Couldn't save. Try again." }).last()).toBeVisible();
    }
  });
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
  test(`converted rows render and toggle at ${width}px in ${theme}`, async () => {
    await withPage({ viewport: { width, height: 900 }, colorScheme: theme }, async page => {
      await mockAPI(page, theme);
      await page.goto(origin + '/agents/plugins/github');
      const capture = async (name, control) => {
        await expect(control).toBeEnabled();
        const card = control.locator('xpath=ancestor::*[@data-slot="card" or self::section][1]');
        for (const checked of [false, true]) {
          if (await control.isChecked() !== checked) await control.click();
          await expect(control).toBeEnabled();
          await expect(control).toHaveAttribute('aria-checked', String(checked));
          await card.scrollIntoViewIfNeeded();
          const box = await control.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width, 'switch stays inside viewport');
          await card.screenshot({ path: join(screenshots, `${name}-${checked ? 'on' : 'off'}-${theme}-${width}.png`), animations: 'disabled' });
        }
      };
      await capture('github-shared', page.getByRole('switch', { name: fallbackLabel }));
      await page.goto(fixture('settings', theme));
      await capture('oidc', page.getByRole('switch', { name: 'Enable single sign-on' }));
      await page.goto(fixture('automations', theme));
      await capture('automatic-pr', page.getByRole('switch', { name: 'Open pull requests automatically' }));
      await capture('schedule', page.getByRole('switch', { name: 'Enable Daily review' }));
      // The same control follows personal accents, without changing neutral off colors.
      const pr = page.getByRole('switch', { name: 'Open pull requests automatically' });
      const blue = await pr.evaluate(el => getComputedStyle(el).backgroundColor);
      await page.locator('html').evaluate(el => { el.dataset.accent = 'purple'; });
      await expect.poll(() => pr.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(blue);
    });
  });
}

// These use the production router and components, not a second Settings/Plugins route table.
test('legacy Settings GitHub hash, query and path bookmarks redirect before Settings mounts', async () => {
  await withPage({}, async page => {
    const state = await mockAPI(page, 'light', { admin: false });
    for (const old of ['#connections', '#connections-settings', '#github', '#shared-github', '?section=connections', '?tab=github', '?anchor=connections', '/connections', '/github']) {
      state.requests.length = 0;
      await page.goto(origin + '/agents/settings' + old);
      await expect(page).toHaveURL(origin + '/agents/plugins/github');
      await expect(page.getByRole('heading', { name: 'GitHub', level: 1, exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Settings', level: 1, exact: true })).toHaveCount(0);
      assert.ok(!state.requests.some(request => /\/me\/(?:deletion|sign-in-methods)|\/sessions$|\/settings\//.test(request.path)), 'redirect must not mount Settings or administrator controls');
    }
    await page.goto(origin + '/agents/settings#chatgpt');
    await expect(page).toHaveURL(origin + '/agents/settings/models#chatgpt');
    await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
  });
});

test('Plugins entry opens GitHub; personal device sign-in/cancel/reconnect/disconnect keep their endpoints', async () => {
  await withPage({}, async page => {
    const state = await mockAPI(page, 'light', { admin: false });
    await page.goto(origin + '/agents/plugins');
    await expect(page.getByRole('heading', { name: 'Plugins', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: /GitHub Manage your GitHub connection/ }).click();
    await expect(page).toHaveURL(origin + '/agents/plugins/github');
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await expect(page.getByLabel('One-time code')).toHaveValue('ABCD-1234');
    await expect(page.getByRole('link', { name: 'Continue on GitHub' })).toHaveAttribute('href', 'https://github.com/login/device');
    await page.getByRole('button', { name: 'Cancel sign-in' }).click();
    await expect(page.getByText('GitHub sign-in cancelled.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('One-time code')).toHaveCount(0);
    await page.getByRole('button', { name: 'Connect GitHub', exact: true }).click();
    await expect(page.getByLabel('One-time code')).toBeVisible();
    state.personal = true; state.login = { status: 'connected' };
    await expect(page.getByText('Signed in as personal-user', { exact: true })).toBeVisible();
    await expect(page.getByText(/To revoke access completely/)).toBeVisible();
    await page.getByRole('button', { name: 'Reconnect GitHub' }).click();
    await expect(page.getByLabel('One-time code')).toHaveValue('ABCD-1234');
    await page.getByRole('button', { name: 'Cancel sign-in' }).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.getByText('Not connected', { exact: true })).toBeVisible();
    assert.ok(state.requests.some(request => request.path === '/api/v1/github' && request.method === 'DELETE'));
    assert.ok(!state.requests.some(request => request.path.includes('/settings/github')), 'members must not request shared credentials');
  });
});

test('administrator shared sign-in and disconnect stay separate from the personal connection', async () => {
  await withPage({}, async page => {
    const state = await mockAPI(page, 'light', { connected: true });
    await page.goto(origin + '/agents/plugins/github');
    const shared = page.getByRole('heading', { name: 'Shared connection', exact: true }).locator('xpath=ancestor::*[@data-slot="card"][1]');
    await expect(shared).toContainText('Shared GitHub account: shared-user');
    await shared.getByRole('button', { name: 'Reconnect GitHub' }).click();
    await expect(shared.getByLabel('One-time code')).toHaveValue('ABCD-1234');
    await shared.getByRole('button', { name: 'Cancel sign-in' }).click();
    await expect(shared.getByLabel('One-time code')).toHaveCount(0);
    await shared.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(shared).toContainText('No shared GitHub account connected');
    await expect(page.getByText('Signed in as personal-user', { exact: true })).toBeVisible();
    assert.ok(state.requests.some(request => request.path === '/api/v1/settings/github/login' && request.method === 'POST'));
    assert.ok(state.requests.some(request => request.path === '/api/v1/settings/github' && request.method === 'DELETE'));
    assert.ok(!state.requests.some(request => request.path === '/api/v1/github' && request.method === 'DELETE'));
  });
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) for (const admin of [false, true]) {
  const role = admin ? 'administrator' : 'member';
  for (const connected of [false, true]) {
    test(`Plugins GitHub ${role}, ${connected ? 'connected' : 'disconnected'}, ${theme}, ${width}px`, async () => {
      await withPage({ viewport: { width, height: 900 }, colorScheme: theme }, async page => {
        const state = await mockAPI(page, theme, { admin, connected });
        await page.goto(origin + '/agents/plugins/github');
        await expect(page.getByRole('heading', { name: 'GitHub', level: 1 })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Your connection', exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Shared connection', exact: true })).toHaveCount(admin ? 1 : 0);
        await expect(page.getByRole('switch', { name: fallbackLabel })).toHaveCount(admin ? 1 : 0);
        await expect(page.getByText(connected ? 'Signed in as personal-user' : 'Not connected', { exact: true })).toBeVisible();
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
        await expect(page.getByRole('button', { name: connected ? 'Reconnect GitHub' : 'Connect GitHub', exact: true })).toHaveCount(admin ? 2 : 1);
        await page.evaluate(() => document.fonts.ready);
        const name = `plugins-github-${role}-${connected ? 'connected' : 'disconnected'}-${theme}-${width}`;
        await page.screenshot({ path: join(screenshots, `${name}.png`), animations: 'disabled' });
        if (admin) {
          const heading = page.getByRole('heading', { name: 'Shared connection', exact: true });
          const card = heading.locator('xpath=ancestor::*[@data-slot="card"][1]');
          await expect(card).toContainText('Administrators manage this connection');
          await expect(card).toContainText('accounts relying on it lose access');
          await expect(card).toContainText(connected ? 'Shared GitHub account: shared-user' : 'No shared GitHub account connected');
          await expect(card).not.toContainText('GitHub CLI is already installed');
          await card.scrollIntoViewIfNeeded();
          await card.screenshot({ path: join(screenshots, `${name}-shared.png`), animations: 'disabled' });
        } else assert.ok(!state.requests.some(request => request.path.includes('/settings/github')));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal page overflow');
      });
    });
  }
  test(`Settings after removing Connections: ${role}, ${theme}, ${width}px`, async () => {
    await withPage({ viewport: { width, height: 900 }, colorScheme: theme }, async page => {
      const state = await mockAPI(page, theme, { admin });
      await page.goto(origin + '/agents/settings');
      await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: /Your connection|Shared connection/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Connect GitHub|Reconnect GitHub|Disconnect/ })).toHaveCount(0);
      await expect(page).toHaveURL(origin + '/agents/settings/account');
      await expect(page.locator('#sign-in-methods')).toBeVisible();
      await page.goto(origin + '/agents/settings/models');
      await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'ChatGPT plan', exact: true })).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(screenshots, `settings-without-connections-${role}-${theme}-${width}.png`), animations: 'disabled' });
      assert.ok(!state.requests.some(request => /\/github(?:\/login)?$/.test(request.path)), 'Settings must not mount GitHub controls');
    });
  });
}

test('GitHub loading and error states stay readable and prevent changing an unknown shared setting', async () => {
  await withPage({}, async page => {
    await mockAPI(page);
    const hold = deferred();
    await page.route('**/api/v1/settings/github', async route => {
      await hold.promise;
      await route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'Only an administrator can manage the shared connection.' } } });
    });
    try {
      await page.goto(origin + '/agents/plugins/github');
      await expect(page.getByText('Checking…', { exact: true })).toBeVisible();
      await expect(page.getByRole('switch', { name: fallbackLabel })).toBeDisabled();
    } finally { hold.release(); }
    await expect(page.getByText("Couldn't check GitHub", { exact: true })).toBeVisible();
    await expect(page.getByRole('switch', { name: fallbackLabel })).toBeDisabled();
  });
});

async function openSettingsPage(page, id, width) {
  const topic = settingsRegistry.SETTINGS_PAGES.find(item => item.id === id);
  if (width < 768) {
    await page.getByRole('combobox', { name: 'Settings page', exact: true }).click();
    await page.getByRole('option', { name: topic.title, exact: true }).click();
  } else await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('link', { name: topic.title, exact: true }).click();
  await expect(page).toHaveURL(origin + '/agents' + topic.route);
}

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) test(`Appearance saves Orange after topic navigation and overrides stale hints: ${theme}, ${width}px`, async () => {
  await withPage({ viewport: { width, height: 900 }, colorScheme: theme }, async page => {
    const state = await mockAPI(page, theme);
    await page.goto(origin + '/agents/settings/account');
    await expect(page.locator('#sign-in-methods')).toBeVisible();
    await expect(page.locator('#sessions')).toBeVisible();
    await openSettingsPage(page, 'models', width);
    await expect(page.getByRole('heading', { name: 'ChatGPT plan', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Model providers', exact: true })).toBeVisible();
    await openSettingsPage(page, 'appearance', width);
    const control = page.locator('#appearance').getByRole('button', { name: 'Color', exact: true });
    await expect(control).toBeEnabled();
    await control.click();
    const saving = page.waitForResponse(response => response.url() === origin + '/api/v1/me/accent' && response.request().method() === 'PUT');
    await page.getByRole('menuitemradio', { name: 'Orange', exact: true }).click();
    const response = await saving;
    assert.equal(response.status(), 200);
    assert.deepEqual(response.request().postDataJSON(), { accent: 'orange' });
    assert.deepEqual(await response.json(), { accent: 'orange' });
    await expect(page.locator('html')).toHaveAttribute('data-accent', 'orange');
    await expect(control).toHaveText('Orange');
    await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toHaveText(theme === 'light' ? 'Light' : 'Dark');
    await openSettingsPage(page, 'account', width);
    await expect(control).toBeHidden();
    await openSettingsPage(page, 'appearance', width);
    await expect(control).toHaveText('Orange');
    for (const hint of ['purple', 'not-an-accent']) {
      await page.evaluate(value => localStorage.setItem('gond-agent-accent', value), hint);
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-accent', 'orange');
      await expect(control).toHaveText('Orange');
      assert.equal(await page.evaluate(() => localStorage.getItem('gond-agent-accent')), 'orange');
    }
    assert.deepEqual(state.puts, [{ path: '/api/v1/me/accent', body: { accent: 'orange' } }]);
    await page.screenshot({ path: join(settingsScreenshots, `appearance-orange-${theme}-${width}.png`), animations: 'disabled' });
  });
});

for (const width of [1440, 390]) for (const theme of ['light', 'dark']) for (const admin of [true, false]) {
  const role = admin ? 'administrator' : 'member';
  test(`Settings topic pages and old URL screenshots: ${role}, ${theme}, ${width}px`, async () => {
    await withPage({ viewport: { width, height: 900 }, colorScheme: theme }, async page => {
      const state = await mockAPI(page, theme, { admin });
      await page.goto(origin + '/agents/settings');
      await expect(page).toHaveURL(origin + '/agents/settings/account');
      const available = settingsRegistry.settingsPages(admin);
      if (width >= 768) {
        const nav = page.getByRole('navigation', { name: 'Settings pages' });
        await expect(nav.getByRole('link')).toHaveText(available.map(item => item.title));
        await expect(page.getByRole('combobox', { name: 'Settings page' })).toBeHidden();
      } else {
        await expect(page.getByRole('navigation', { name: 'Settings pages' })).toBeHidden();
        await page.getByRole('combobox', { name: 'Settings page' }).click();
        await expect(page.getByRole('option')).toHaveText(available.map(item => item.title));
        await page.keyboard.press('Escape');
      }
      for (const topic of available) {
        await openSettingsPage(page, topic.id, width);
        await expect(page.getByRole('heading', { name: topic.title, level: 2, exact: true })).toBeVisible();
        if (width >= 768) await expect(page.getByRole('navigation', { name: 'Settings pages' }).locator('[aria-current="page"]')).toHaveText(topic.title);
        else await expect(page.getByRole('combobox', { name: 'Settings page' })).toHaveText(topic.title);
        await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
        const panel = page.locator(`[data-settings-page="${topic.id}"]`);
        for (const section of topic.sections) {
          if (admin || !section.adminOnly) {
            await expect(panel.locator('#' + section.id)).toBeVisible();
            // Settle async card contents before screenshots.
            await expect(panel.getByText('Loading…', { exact: true })).toHaveCount(0);
          } else await expect(panel.locator('#' + section.id)).toHaveCount(0);
        }
        await page.evaluate(() => document.fonts.ready);
        const prefix = `${topic.id}-${role}-${theme}-${width}`;
        await page.screenshot({ path: join(settingsScreenshots, prefix + '.png'), animations: 'disabled' });
        // A full panel capture includes long topic pages below the first screen.
        await panel.evaluate(el => { el.style.height = 'auto'; el.style.overflow = 'visible'; });
        await panel.screenshot({ path: join(settingsScreenshots, prefix + '-content.png'), animations: 'disabled' });
        await panel.evaluate(el => { el.style.height = ''; el.style.overflow = ''; });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal viewport overflow');
      }
      // Each accessible topic also has a legacy bookmark capture after canonicalization.
      for (const topic of available) {
        const section = topic.sections.find(item => admin || !item.adminOnly);
        await page.goto(origin + '/agents/settings#' + section.id);
        await expect(page).toHaveURL(origin + '/agents' + settingsRegistry.settingsHref(section.id));
        await expect(page.locator('#' + section.id)).toBeFocused();
        await page.screenshot({ path: join(settingsScreenshots, `redirect-${topic.id}-${role}-${theme}-${width}.png`), animations: 'disabled' });
      }
      if (!admin) {
        await page.goto(origin + '/agents/settings/sign-in-people');
        await expect(page).toHaveURL(origin + '/agents/settings/account');
        await expect(page.locator('#oidc, #people')).toHaveCount(0);
        await page.screenshot({ path: join(settingsScreenshots, `sign-in-people-denied-${role}-${theme}-${width}.png`), animations: 'disabled' });
        assert.ok(!state.requests.some(item => /\/settings\/(providers|oidc|people|web-search)$/.test(item.path)), 'member pages never mount admin forms');
      }
      assert.ok(!state.requests.some(item => /\/github(?:\/login)?$/.test(item.path)), 'no GitHub controls in any Settings page');
    });
  });
}

test('all legacy section aliases, queries and section paths resolve through the production router', async () => {
  for (const topic of settingsRegistry.SETTINGS_PAGES) for (const section of topic.sections) for (const anchor of [section.id, ...section.anchors]) {
    for (const suffix of ['#' + anchor, '?section=' + anchor, '?tab=' + anchor, '?anchor=' + anchor, '/' + anchor]) {
      // Bound Chromium history/document retention in the 2 GiB CI container.
      await withPage({}, async page => {
        await mockAPI(page);
        await page.goto(origin + '/agents/settings' + suffix);
        const resolved = settingsRegistry.resolveSettingsLocation('/settings' + (suffix.startsWith('/') ? suffix : ''), suffix.startsWith('#') ? suffix : '', suffix.startsWith('?') ? suffix : '', true);
        await expect(page).toHaveURL(origin + '/agents' + resolved.to);
        await expect(page.getByRole('heading', { name: topic.title, level: 2, exact: true })).toBeVisible();
      });
    }
  }
});

test('Settings links support arrows, Home/End, Enter, Tab order and aria-current without activating on focus', async () => {
  await withPage({ viewport: { width: 1440, height: 900 } }, async page => {
    await mockAPI(page);
    await page.goto(origin + '/agents/settings/account');
    const nav = page.getByRole('navigation', { name: 'Settings pages' });
    const account = nav.getByRole('link', { name: 'Account', exact: true });
    const appearance = nav.getByRole('link', { name: 'Appearance', exact: true });
    await account.focus();
    await page.keyboard.press('ArrowDown');
    await expect(appearance).toBeFocused();
    await expect(account).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(origin + '/agents/settings/appearance');
    await expect(appearance).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('ArrowUp');
    await expect(account).toBeFocused();
    await page.keyboard.press('End');
    await expect(nav.getByRole('link', { name: 'Danger zone' })).toBeFocused();
    await page.keyboard.press('Home');
    await expect(account).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(appearance).toBeFocused();
    await nav.getByRole('link', { name: 'Danger zone' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeFocused();
  });
});

test('mobile Settings select supports keyboard navigation and selection', async () => {
  await withPage({ viewport: { width: 390, height: 900 } }, async page => {
    await mockAPI(page, 'light', { admin: false });
    await page.goto(origin + '/agents/settings');
    const select = page.getByRole('combobox', { name: 'Settings page' });
    await select.focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('option', { name: 'Account', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('option', { name: 'Appearance', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(origin + '/agents/settings/appearance');
    // BrowserRouter updates the URL before its transition commits the new panel.
    await expect(page.getByRole('heading', { name: 'Appearance', level: 2, exact: true })).toBeVisible();
    await expect(select).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Theme', exact: true })).toBeFocused();
  });
});

for (const width of [1440, 390]) test(`topic navigation retains unsaved provider/OIDC drafts, details and scroll at ${width}px`, async () => {
  await withPage({ viewport: { width, height: 600 } }, async page => {
    const state = await mockAPI(page);
    await page.goto(origin + '/agents/settings/sign-in-people');
    await page.getByLabel('Button label', { exact: true }).fill('Unsaved identity');
    await page.getByLabel('Client secret', { exact: true }).fill('fixture-only-unsaved-secret');
    await page.getByRole('switch', { name: 'Enable single sign-on' }).click();
    const panel = page.locator('[data-settings-page="sign-in-people"]');
    await panel.evaluate(el => { el.scrollTop = 170; });
    const scroll = await panel.evaluate(el => el.scrollTop);
    assert.ok(scroll > 0, 'fixture must exercise actual scrolling');
    await openSettingsPage(page, 'models', width);
    await page.getByRole('button', { name: '+ Add provider', exact: true }).click();
    await page.getByLabel('API key', { exact: true }).fill('fixture-only-unsaved-key');
    await page.getByText('Advanced settings', { exact: true }).click();
    await page.getByLabel('Connection name', { exact: true }).fill('Unsaved provider');
    await openSettingsPage(page, 'appearance', width);
    await openSettingsPage(page, 'sign-in-people', width);
    await expect(page.getByLabel('Button label', { exact: true })).toHaveValue('Unsaved identity');
    await expect(page.getByLabel('Client secret', { exact: true })).toHaveValue('fixture-only-unsaved-secret');
    await expect(page.getByRole('switch', { name: 'Enable single sign-on' })).toBeChecked();
    assert.equal(await panel.evaluate(el => el.scrollTop), scroll);
    await openSettingsPage(page, 'models', width);
    await expect(page.getByLabel('API key', { exact: true })).toHaveValue('fixture-only-unsaved-key');
    await expect(page.getByLabel('Connection name', { exact: true })).toHaveValue('Unsaved provider');
    await page.goBack();
    await expect(page.getByLabel('Button label', { exact: true })).toHaveValue('Unsaved identity');
    assert.equal(state.puts.length, 0, 'navigation must not save drafts');
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-only-unsaved')), false, 'secrets are not cached');
  });
});

for (const admin of [true, false]) test(`search uses registry routes/anchors, hides admin items, and never deletes (${admin ? 'admin' : 'member'})`, async () => {
  await withPage({ viewport: { width: 1440, height: 900 } }, async page => {
    const state = await mockAPI(page, 'light', { admin });
    await page.goto(origin + '/agents/settings/account');
    const open = async text => {
      await page.getByRole('button', { name: 'Search', exact: true }).click();
      await page.getByRole('textbox', { name: 'Search', exact: true }).fill(text);
    };
    for (const item of settingsRegistry.settingsSearchItems(admin)) {
      await open(item.title);
      await page.getByRole('option', { name: item.title, exact: true }).click();
      await expect(page).toHaveURL(origin + '/agents' + item.to);
      await expect(page.locator('#' + item.to.split('#')[1])).toBeFocused();
    }
    if (!admin) for (const title of ['Model providers', 'Single sign-on', 'People', 'Web search']) {
      await open(title);
      await expect(page.getByRole('option', { name: title, exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    await open('erase close');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(origin + '/agents/settings/danger-zone#delete');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.ok(!state.requests.some(item => item.method === 'DELETE'), 'search only navigates');
  });
});

test('cold deep links follow delayed card layout, then preserve user scroll on Back', async () => {
  await withPage({ viewport: { width: 1440, height: 600 } }, async page => {
    await mockAPI(page);
    const hold = deferred();
    await page.route('**/api/v1/settings/oidc', async route => { await hold.promise; await route.fallback(); });
    try {
      await page.goto(origin + '/agents/settings/sign-in-people#people');
      await expect(page.locator('#people')).toBeFocused();
    } finally { hold.release(); }
    await expect(page.getByLabel('Button label', { exact: true })).toHaveValue('Single sign-on');
    const people = page.locator('#people');
    await expect.poll(async () => {
      const box = await people.boundingBox();
      return box.y >= 130 && box.y < 570;
    }).toBe(true);
    // Explicit section navigation still aligns, even on an already visited page.
    await page.goto(origin + '/agents/settings/models#providers');
    await page.getByRole('button', { name: '+ Add provider', exact: true }).click();
    await expect(page.getByLabel('API key', { exact: true })).toBeVisible();
    const panel = page.locator('[data-settings-page="models"]');
    await panel.hover();
    const initialScroll = await panel.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, 280);
    await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBeGreaterThan(initialScroll);
    const before = await panel.evaluate(el => el.scrollTop);
    assert.ok(before > 0);
    await openSettingsPage(page, 'appearance', 1440);
    await page.goBack();
    await expect(page).toHaveURL(origin + '/agents/settings/models#providers');
    await expect(page.getByLabel('API key', { exact: true })).toBeVisible();
    await expect.poll(() => panel.evaluate(el => el.scrollTop)).toBe(before);
  });
});
