import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
const format = {}
new Function('exports', compile(readFileSync(new URL('../src/lib/format.ts', import.meta.url), 'utf8')))(format)
// Render the actual diff components; the unrelated model/status components and
// their dependencies aren't part of this test. Browser tests check real CSS.
const source = readFileSync(new URL('../src/features/studio/parts.tsx', import.meta.url), 'utf8')
const file = ts.createSourceFile('parts.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const components = file.statements.filter(n => ts.isFunctionDeclaration(n) && ['DiffCounts', 'DiffSquares', 'DiffTile'].includes(n.name?.text)).map(n => n.getText()).join('\n')
const parts = {}
new Function('require', 'exports', 'cn', 'mono', 'compactCount', compile(components))(require, parts, (...args) => twMerge(clsx(args)), {}, format.compactCount)

test('compact counts stay short at unit boundaries without inflating the count', () => {
  for (const [n, expected] of [[0, '0'], [999, '999'], [1000, '1k'], [2605, '2.6k'], [9999, '9.9k'], [11456, '11.4k'], [99999, '99.9k'], [100000, '100k'], [999999, '999k'], [1000000, '1m'], [999999999, '999m'], [1e9, '1b']]) {
    assert.equal(format.compactCount(n), expected)
    assert.ok(format.compactCount(n).length <= 5)
  }
})

test('list tile abbreviates both five-digit counts, retains exact tooltip and all five squares', () => {
  const html = renderToStaticMarkup(createElement(parts.DiffTile, { files: 77, add: 11456, del: 99999, status: 'ready' }))
  assert.match(html, /data-diff-tile/)
  assert.match(html, /title="\+11456 −99999"/)
  assert.match(html, />\+11\.4k</)
  assert.match(html, />−99\.9k</)
  assert.equal((html.match(/size-\[7px\]/g) || []).length, 5)
  const exact = renderToStaticMarkup(createElement(parts.DiffCounts, { add: 11456, del: 99999 }))
  assert.match(exact, />\+11456</)
  assert.match(exact, />−99999</)
  assert.doesNotMatch(exact, /11\.4k/)
})
