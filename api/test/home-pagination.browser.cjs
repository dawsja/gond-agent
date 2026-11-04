const { history } = require('./fixtures/pagination.cjs');

// Runs against either the real authenticated onboarding workspace or the local
// mock-UI harness. Only the history endpoint is replaced here, never the controls.
exports.verifyPagination = async ({ page, expect, origin, capture }) => {
  let rows = history();
  const requests = [];
  const handler = async route => {
    const q = new URL(route.request().url()).searchParams;
    const limit = Number(q.get('limit') || 100);
    const requested = Number(q.get('offset') || 0);
    requests.push({ limit, offset: requested });
    const repo = q.get('repo');
    const eligible = rows.filter(r => !repo || r.repo === repo);
    const counts = {
      all: eligible.length, working: eligible.filter(r => ['working', 'queued'].includes(r.status)).length,
      active: eligible.filter(r => r.status === 'working').length, queued: eligible.filter(r => r.status === 'queued').length,
      ready: eligible.filter(r => r.status === 'ready').length, merged: eligible.filter(r => r.status === 'merged').length,
    };
    const tab = q.get('tab') || 'all';
    const matched = eligible.filter(r => tab === 'all' || (tab === 'working' ? ['working', 'queued'].includes(r.status) : r.status === tab));
    const offset = requested < matched.length ? requested : Math.max(0, Math.ceil(matched.length / limit) - 1) * limit;
    await route.fulfill({ json: { runs: matched.slice(offset, offset + limit), total: matched.length, counts, repositories: ['acme/app', 'acme/web'], limit, offset } });
  };
  const pattern = origin + '/api/v1/runs?*';
  await page.route(pattern, handler);
  const list = page.getByRole('list', { name: 'Runs', exact: true });
  const range = page.getByRole('navigation', { name: 'Runs pagination' }).getByRole('status');
  const size = page.getByRole('combobox', { name: 'Rows per page' });
  const next = page.getByRole('button', { name: 'Next page', exact: true });
  const previous = page.getByRole('button', { name: 'Previous page', exact: true });
  const shot = async name => {
    await page.getByRole('navigation', { name: 'Runs pagination' }).scrollIntoViewIfNeeded();
    const cards = list.locator(':scope > li');
    const counts = cards.locator('[data-diff-counts]').filter({ visible: true });
    await expect(counts).toHaveCount(await cards.count());
    for (const count of await counts.all()) {
      await expect(count).toHaveText('+11.4k−99.9k');
      await expect(count).toHaveAttribute('title', '+11456 −99999');
    }
    // Text and squares must stay inside the tile (desktop) or row (mobile),
    // not merely inside the document's scroll width.
    expect(await cards.evaluateAll(cards => cards.every(card => {
      const tile = card.querySelector('[data-diff-tile]');
      const box = tile && tile.getBoundingClientRect().width ? tile : card;
      const bounds = box.getBoundingClientRect();
      return [...box.querySelectorAll('[data-diff-counts], [data-diff-counts] > span, [data-diff-squares], [data-diff-squares] > span')].every(el => {
        const r = el.getBoundingClientRect();
        return !r.width || r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom;
      }) && card.scrollWidth <= card.clientWidth;
    }))).toBe(true);
    if (page.viewportSize().width >= 768) await expect(cards.locator('[data-diff-squares] > span')).toHaveCount(await cards.count() * 5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture('pagination-' + name);
  };
  const selectSize = async value => {
    await size.click();
    await page.getByRole('option', { name: String(value), exact: true }).click();
  };
  try {
    await page.goto(origin + '/agents/');
    await page.evaluate(() => localStorage.removeItem('gond-agent.runs-page-size'));
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(origin + '/agents/?page=1&size=25');
      await expect(range).toHaveText('1-25 of 65');
      await expect(list.locator(':scope > li')).toHaveCount(25);
      await expect(previous).toBeDisabled();
      await shot('default-' + theme);

      // Real Radix keyboard interaction, with the trigger retaining focus.
      await size.focus(); await page.keyboard.press('Enter');
      await expect(page.getByRole('option', { name: '25', exact: true })).toBeVisible();
      await page.keyboard.press('Home');
      await expect(page.getByRole('option', { name: '10', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(size).toHaveText('10');
      await expect(list.locator(':scope > li')).toHaveCount(10);
      await expect(range).toHaveText('1-10 of 65');
      await expect(page).toHaveURL(/page=1&size=10/);
      await expect(size).toBeFocused();
      await page.keyboard.press('Tab'); await expect(next).toBeFocused();
      await page.keyboard.press('Shift+Tab'); await expect(size).toBeFocused();
      await shot('size-10-' + theme);

      await selectSize(100);
      await expect(list.locator(':scope > li')).toHaveCount(65);
      await expect(next).toBeDisabled();
      await expect(range).toHaveText('1-65 of 65');
      await shot('size-100-' + theme);

      await selectSize(25);
      await next.click(); await expect(range).toHaveText('26-50 of 65');
      await next.click(); await expect(range).toHaveText('51-65 of 65');
      await expect(next).toBeDisabled();
      await expect(list.locator(':scope > li')).toHaveCount(15);
      await shot('last-page-' + theme);
      await page.reload(); await expect(range).toHaveText('51-65 of 65');
      await previous.click(); await expect(range).toHaveText('26-50 of 65');

      await page.getByRole('tab', { name: /^Working/ }).click();
      await expect(page).toHaveURL(/page=1&size=25&tab=working/);
      await expect(range).toHaveText('1-25 of 26');
      await shot('working-' + theme);
      await next.click(); await expect(range).toHaveText('26-26 of 26');
      await page.getByRole('button', { name: 'All repositories', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'acme/app', exact: true }).click();
      await expect(page).toHaveURL(/page=1.*repo=acme%2Fapp/);
      await expect(range).toHaveText('1-13 of 13');
      await expect(list.locator(':scope > li')).toHaveCount(13);
    }

    // Remembered size is used for the very first Home page request, not a later
    // effect correcting an initial 25-row request. Recent sidebar requests differ.
    await page.goto(origin + '/agents/settings');
    await page.evaluate(() => localStorage.setItem('gond-agent.runs-page-size', '10'));
    requests.length = 0;
    await page.goto(origin + '/agents/');
    await expect(range).toHaveText('1-10 of 65');
    expect(requests.filter(q => q.limit !== 100)[0]).toEqual({ limit: 10, offset: 0 });
    expect(requests.some(q => q.limit === 25)).toBe(false);
    await expect(size).toHaveText('10');

    await page.goto(origin + '/agents/?page=999&size=25');
    await expect(range).toHaveText('51-65 of 65');
    await expect(page).toHaveURL(/page=3&size=25/);
    await page.goto(origin + '/agents/?page=bad&size=bad');
    await expect(range).toHaveText('1-25 of 65');
    await expect(page).toHaveURL(/page=1&size=25/);

    await next.click(); await expect(range).toHaveText('26-50 of 65');
    const before = await list.locator(':scope > li').first().innerText();
    const newlyReady = rows.find(r => r.status === 'working');
    newlyReady.status = 'ready';
    rows.unshift({ ...rows[0], id: 'new-run', title: 'Newly started run', status: 'working', created_at: rows[0].created_at + 1 });
    await expect(range).toHaveText('26-50 of 66', { timeout: 10000 });
    await expect(page).toHaveURL(/page=2&size=25/);
    await expect(list.locator(':scope > li').first()).not.toHaveText(before);
    await expect(list.locator(':scope > li')).toHaveCount(25);
    const allRows = rows;
    rows = rows.slice(0, 10);
    await expect(range).toHaveText('1-10 of 10', { timeout: 10000 });
    await expect(page).toHaveURL(/page=1&size=25/);
    await expect(next).toBeDisabled();
    // A cached page-2 response now contains offset 0. After growth, a fresh Next
    // must not let that stale clamped response push the URL backward again.
    rows = allRows;
    await expect(range).toHaveText('1-25 of 66', { timeout: 10000 });
    await next.click();
    await expect(range).toHaveText('26-50 of 66');
    await expect(page).toHaveURL(/page=2&size=25/);
  } finally {
    await page.unroute(pattern, handler);
    await page.evaluate(() => localStorage.removeItem('gond-agent.runs-page-size'));
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(origin + '/agents/settings');
  }
};
