import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import ts from 'typescript'

const source = readFileSync(new URL('../src/features/run/queue-reason.tsx', import.meta.url), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const exports = {}
new Function('require', 'exports', code)(createRequire(import.meta.url), exports)
const render = run => renderToStaticMarkup(createElement(exports.QueueReason, { run }))

test('queued reason is readable and points to Close workspace only when safe idle capacity exists', () => {
  const queue_reason = 'All 2 workspaces are in use: 1 working, 1 idle. Idle workspaces can be closed to free a slot.'
  const html = render({ queue_reason, capacity: { idle_releasable: 1 } })
  assert.ok(html.includes(queue_reason))
  assert.match(html, /Use Close workspace on an idle run/)
  assert.doesNotMatch(render({ queue_reason, capacity: { idle_releasable: 0 } }), /Use Close workspace/)
  assert.doesNotMatch(render({ queue_reason }), /Use Close workspace/)
  assert.equal(render({}), '<div class="mt-1 text-[13px] text-muted-foreground"></div>')
})
