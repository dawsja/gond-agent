// Real React/Radix components and styles, with same-origin API route fixtures.
// Run: npm exec --call 'node --test test/settings-switch.browser.cjs' (from web/).
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { chromium, expect } = require('@playwright/test');
let server, browser, origin;
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
});
after(async () => { await browser?.close(); await server?.close(); });

async function mockAPI(page, theme = 'light', { admin = true, connected = false } = {}) {
  const state = { fallback: false, auto_pr: true, enabled: true, puts: [], personal: connected, shared: connected, login: { status: 'idle' }, sharedLogin: { status: 'idle' }, requests: [] };
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
      else if (path.endsWith('/enabled')) state.enabled = body.enabled;
      else if (path !== '/api/v1/settings/oidc') throw new Error(`Unexpected mutation ${path}`);
      return route.fulfill({ json: { ok: true } });
    }
    const responses = {
      '/api/auth/get-session': { session: { id: 'fixture-session', userId: user.id, expiresAt: new Date(Date.now() + 86400000).toISOString() }, user },
      '/api/v1/me': { theme, accent: 'blue', admin, user, setup_required: false, automations: { auto_pr: state.auto_pr } },
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
    await expect(page).toHaveURL(origin + '/agents/settings#chatgpt');
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
      await expect(page.getByText('ChatGPT plan', { exact: true })).toBeVisible();
      await expect(page.locator('#sign-in-methods')).toHaveCount(1);
      await page.getByRole('heading', { name: 'Models', exact: true }).evaluate(el => {
        const scroller = el.closest('main').lastElementChild;
        scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        window.scrollTo(0, 0);
      });
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
