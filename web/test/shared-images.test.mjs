import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
const require = createRequire(import.meta.url)
const cache = new Map()
function load(path) {
  if (cache.has(path.href)) return cache.get(path.href)
  const exports = {}; cache.set(path.href, exports)
  const source = readFileSync(path, 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  new Function('require', 'exports', code)(name => name.startsWith('.') ? load(new URL(name + '.ts', path)) : require(name), exports)
  return exports
}
// Compile the real fold and its pure dependencies, not a replacement reducer.
const { createTranscript } = load(new URL('../src/features/run/transcript.ts', import.meta.url))
test('shared images are first-class ordered transcript items, including replay', () => {
  const fold = createTranscript()
  const events = [
    { type: 'text.delta', agent_id: 'main', text: 'Desktop:', seq: 1, ts: 1 },
    { type: 'image.shared', agent_id: 'main', image_id: 'img_test', media_type: 'image/png', caption: 'Desktop pagination', seq: 2, ts: 2 },
    { type: 'text.delta', agent_id: 'main', text: 'Done.', seq: 3, ts: 3 },
  ]
  const result = fold(events)
  assert.deepEqual(result.items.map(i => i.kind), ['text', 'shared-image', 'text'])
  assert.equal(result.items[1].caption, 'Desktop pagination')
  assert.equal(result.items[1].imageId, 'img_test')
  assert.deepEqual(fold(events).items, result.items)
})
test('legacy text and tool images retain their existing shape', () => {
  const fold = createTranscript()
  const result = fold([
    { type: 'tool.start', call_id: 'r', name: 'read', input: { path: 'a.png' }, seq: 1, ts: 1 },
    { type: 'tool.images', call_id: 'r', images: [{ id: 'old', media_type: 'image/jpeg' }], seq: 2, ts: 2 },
    { type: 'text.delta', text: 'Legacy reply', seq: 3, ts: 3 },
  ])
  assert.deepEqual(result.items[0].tools[0].images, [{ id: 'old', media_type: 'image/jpeg' }])
  assert.equal(result.items[1].text, 'Legacy reply')
})
test('a service cap rejection tells the person the image was not saved', () => {
  const result = createTranscript()([{ type: 'image.share_rejected', agent_id: 'main', seq: 1, ts: 1 }])
  assert.deepEqual(result.items.map(({ kind, text }) => ({ kind, text })), [
    { kind: 'run-message', text: 'Image sharing limit reached. This image was not saved.' },
  ])
})

test('real Markdown renders absolute same-origin images without allowing lookalike remote origins', () => {
  const { Prose } = load(new URL('../../shared/prose.tsx', import.meta.url))
  const previousWindow = globalThis.window
  globalThis.window = { location: new URL('https://workspace.example.test/agents/') }
  try {
    for (const path of ['/agents/favicon-32.png', '/agents/nested/../favicon-32.png', '/api/v1/runs/run_fixture/images/img_fixture']) {
      const src = `https://workspace.example.test${path}`
      const html = renderToStaticMarkup(createElement(Prose, { text: `![Local diagram](${src})` }))
      assert.ok(html.includes(`<img src="${src}" alt="Local diagram"`), html)
    }
    for (const src of ['https://workspace.example.test.evil.test/screen.png', 'https://workspace.example.test@evil.test/screen.png', 'http://workspace.example.test/screen.png', 'https://workspace.example.test:444/screen.png']) {
      const html = renderToStaticMarkup(createElement(Prose, { text: `![Remote](${src})` }))
      assert.match(html, /<a href=/)
      assert.doesNotMatch(html, /<img/)
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('real Markdown never loads same-origin API routes or ambiguous image paths', () => {
  const { Prose } = load(new URL('../../shared/prose.tsx', import.meta.url))
  const previousWindow = globalThis.window
  globalThis.window = { location: new URL('https://workspace.example.test/agents/') }
  try {
    const paths = [
      '/api/v1/runs', '/api/v1/me', '/api/auth/get-session', '/api/auth/sign-out',
      '/other/screen.png', '/agents-other/screen.png',
      '/agents/../api/v1/runs', '/agents/%2e%2e/api/v1/me',
      '/agents/nested/%2E%2E/favicon-32.png', '/agents/%252e%252e%252fapi/v1/me',
      '/agents/nested%2f..%2f..%2fapi/v1/me', '/agents/%5c..%5capi/v1/me',
      '/agents/..\\api/v1/me',
      '/agents/favicon-32.png?refresh=1', '/agents/favicon-32.png#preview',
      '/agents/favicon-32.png?', '/agents/favicon-32.png#',
      '/api/v1/runs/run_fixture/images/img_fixture?refresh=1',
      '/api/v1/runs/run_fixture/images/img_fixture#preview',
      '/api/v1/runs/run_fixture/images/img_fixture?',
      '/api/v1/runs/run_fixture/images/img_fixture#',
      '/api/v1/runs/run.fixture/images/img_fixture',
      '/api/v1/runs/run_fixture/images/img_fixture/extra',
      '/api/v1/runs/run_fixture/images/',
    ]
    for (const path of paths) {
      const src = `https://workspace.example.test${path}`
      const html = renderToStaticMarkup(createElement(Prose, { text: `![Blocked](<${src}>)` }))
      assert.doesNotMatch(html, /<img/, `${src}: ${html}`)
      assert.ok(html.includes('<a href=') || html.includes('image not available'), html)
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('real Markdown rendering explains local paths and never requests remote images', () => {
  const { Prose } = load(new URL('../../shared/prose.tsx', import.meta.url))
  for (const path of ['/tmp/screen.png', './screenshot.png', 'file:///tmp/screen.png', '../private.png']) {
    const html = renderToStaticMarkup(createElement(Prose, { text: `![Desktop](${path})` }))
    assert.match(html, /Desktop/)
    assert.match(html, /text-muted-foreground/)
    assert.match(html, /image not available \(local path\)/)
    assert.doesNotMatch(html, /<img/)
  }
  const remote = renderToStaticMarkup(createElement(Prose, { text: '![Remote](https://example.test/screenshot.png)' }))
  assert.match(remote, /<a href="https:\/\/example.test\/screenshot.png"/)
  assert.doesNotMatch(remote, /<img/)
})
