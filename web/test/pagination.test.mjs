import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../../shared/pagination.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 } }).outputText
const { homePage, pageSize, pageRows, pagination } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const home = readFileSync(new URL('../src/features/home/home-screen.tsx', import.meta.url), 'utf8')
const control = readFileSync(new URL('../../shared/ui/pagination.tsx', import.meta.url), 'utf8')

test('first render resolves URL before remembered browser size, with strict defaults', () => {
  assert.deepEqual(homePage(new URLSearchParams(), '10'), { page: 1, size: 10 })
  assert.deepEqual(homePage(new URLSearchParams('page=3&size=50'), '10'), { page: 3, size: 50 })
  for (const value of ['-1', '1.5', '2x', 'NaN', '0', '9007199254740992', '']) {
    assert.deepEqual(homePage(new URLSearchParams(`page=${value}&size=${value}`), '10'), { page: 1, size: 25 })
  }
  assert.deepEqual(homePage(new URLSearchParams(), 'invalid'), { page: 1, size: 25 })
  assert.match(home, /useState\(\(\) => prefs\.get\("runs-page-size"\)\)/)
  assert.match(home, /homePage\(search, rememberedSize\)/)
})

test('one helper clamps last/empty pages and calculates inclusive live ranges', () => {
  assert.deepEqual(pagination(65, 25, 0), { total: 65, limit: 25, offset: 0, start: 1, end: 25 })
  assert.deepEqual(pagination(65, 25, 9999), { total: 65, limit: 25, offset: 50, start: 51, end: 65 })
  assert.deepEqual(pagination(0, 25, 50), { total: 0, limit: 25, offset: 0, start: 0, end: 0 })
  assert.equal(pagination(66, 25, 25).offset, 25, 'insertions keep the current page')
  assert.equal(pagination(10, 25, 25).offset, 0, 'shrinking totals clamp the current page')
  assert.equal(homePage(new URLSearchParams('page=9007199254740991&size=100'), null).page * 100 <= Number.MAX_SAFE_INTEGER, true)
})

test('render boundary guard: Home maps only the bounded pageRows result', () => {
  const file = ts.createSourceFile('home.tsx', home, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declarations = []
  const rows = []
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'shown') declarations.push(node.initializer.getText(file))
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'RunRow') rows.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.deepEqual(declarations, ['pageRows(data?.runs ?? [], size)'])
  assert.equal(rows.length, 1)
  let parent = rows[0].parent
  while (parent && !ts.isCallExpression(parent)) parent = parent.parent
  assert.equal(parent.expression.getText(file), 'shown.map')
  for (const size of [10, 25, 50, 100]) {
    const history = Array.from({ length: 1000 }, (_, i) => i)
    assert.deepEqual(pageRows(history, size), history.slice(0, size))
    assert.equal(pageSize(String(size)), size)
  }
})

test('shared controls retain accessible labels/live range and native focusable primitives', () => {
  for (const label of ['Runs pagination', 'Rows per page', 'Previous page', 'Next page']) assert.ok(control.includes(`"${label}"`))
  assert.match(control, /aria-live="polite"/)
  assert.match(control, /<SelectTrigger id=\{id\}/)
  assert.match(control, /<label htmlFor=\{id\}/)
  assert.match(control, /<Button[^>]+disabled=\{busy \|\| page <= 1\}/)
  assert.match(control, /<Button[^>]+disabled=\{busy \|\| end >= total\}/)
  // Keyboard interaction, refresh, reset, first-request size and live updates are
  // exercised against rendered React by home-pagination.browser.cjs.
  assert.match(home, /setPage\(1, \{ tab: v \}\)/)
  assert.match(home, /setPage\(1, \{ repo: value \}\)/)
  assert.match(home, /setSearch\(params, \{ replace: true \}\)/)
  assert.match(home, /data && !isFetching \? Math\.floor\(data\.offset \/ size\) \+ 1 : page/)
  const docker = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8')
  assert.match(docker, /COPY shared\/[^\n]*shared\/pagination\.ts \/app\/shared\//)
})
