import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SETTINGS_PAGES, SETTINGS_EXTERNAL_REDIRECTS, settingsPages, settingsHref, settingsSearchItems, resolveSettingsLocation } from '../src/features/settings/registry.ts'

const oldAnchors = ['personal-settings', 'appearance', 'model-settings', 'chatgpt', 'providers', 'security-settings', 'sign-in-methods', 'oidc', 'sessions', 'people-settings', 'agent-access-settings', 'web-search', 'mcp', 'account-management-settings', 'delete', 'connections', 'connections-settings', 'github', 'shared-github']
const resolve = (suffix, admin = true) => {
  const url = new URL('/settings' + suffix, 'https://example.test')
  return resolveSettingsLocation(url.pathname, url.hash, url.search, admin)
}

test('each existing Settings section has exactly one owner and every historical anchor has a destination', () => {
  const sections = SETTINGS_PAGES.flatMap(page => page.sections)
  assert.equal(new Set(sections.map(section => section.id)).size, sections.length)
  assert.deepEqual(sections.map(section => section.id).sort(), ['account', 'appearance', 'chatgpt', 'providers', 'sign-in-methods', 'oidc', 'sessions', 'people', 'web-search', 'mcp', 'delete'].sort())
  assert.equal(new Set(SETTINGS_PAGES.map(page => page.route)).size, SETTINGS_PAGES.length)
  const anchors = [...sections.flatMap(section => [section.id, ...section.anchors]), ...SETTINGS_EXTERNAL_REDIRECTS.flatMap(item => item.anchors)]
  assert.equal(new Set(anchors).size, anchors.length, 'aliases must not have competing owners')
  for (const anchor of oldAnchors) {
    assert.ok(anchors.includes(anchor), anchor)
    assert.notEqual(resolve('#' + anchor).to, '/settings/account', anchor)
  }
  const screen = readFileSync(new URL('../src/features/settings/settings-screen.tsx', import.meta.url), 'utf8')
  assert.match(screen, /Record<SettingsSectionId,/)
  assert.match(screen, /page\.sections\.filter/)
})

test('registry routes canonicalize old hash/query/path links, preserve callback errors and are idempotent', () => {
  assert.equal(resolve('').to, '/settings/account')
  for (const page of SETTINGS_PAGES) {
    assert.equal(resolve('/' + page.id).to, page.route)
    for (const section of page.sections) for (const anchor of [section.id, ...section.anchors]) {
      for (const suffix of ['#' + anchor, '?section=' + anchor, '?tab=' + anchor, '?anchor=' + anchor, '/' + anchor]) {
        // A canonical page path has no forced section hash.
        const expected = suffix === '/' + page.id ? page.route : settingsHref(section.id)
        assert.equal(resolve(suffix).to, expected, suffix)
      }
      const canonical = resolve('#' + anchor).to
      assert.equal(resolve(canonical.slice('/settings'.length)).to, canonical)
    }
  }
  assert.equal(resolve('?error=already_linked#sign-in-methods').to, '/settings/account?error=already_linked#sign-in-methods')
  assert.equal(resolve('/unknown').to, '/settings/account')
  for (const item of SETTINGS_EXTERNAL_REDIRECTS) for (const anchor of item.anchors) {
    for (const suffix of ['#' + anchor, '?section=' + anchor, '?tab=' + anchor, '?anchor=' + anchor, '/' + anchor]) assert.equal(resolve(suffix).to, item.route)
  }
})

test('member navigation, direct links and search exclude administrator-only settings', () => {
  assert.deepEqual(settingsPages(false).map(page => page.id), ['account', 'appearance', 'models', 'agent-access', 'danger-zone'])
  assert.equal(resolve('/sign-in-people', false).to, '/settings/account')
  assert.equal(resolve('#providers', false).to, '/settings/models')
  assert.equal(resolve('#web-search', false).to, '/settings/agent-access')
  const member = settingsSearchItems(false)
  for (const title of ['Model providers', 'Single sign-on', 'People', 'Web search']) assert.ok(!member.some(item => item.title === title))
  for (const page of settingsPages(true)) for (const section of page.sections) {
    const item = settingsSearchItems(true).find(item => item.title === section.title)
    assert.equal(item.to, `${page.route}#${section.id}`)
    assert.ok(item.keywords.includes(section.keywords))
  }
})
