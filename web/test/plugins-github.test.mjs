import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(new URL(`${entry.name}/`, dir)) : /\.[jt]sx?$/.test(entry.name) ? [new URL(entry.name, dir)] : [])

test('Settings cannot import or render GitHub connection controls, including under aliases', () => {
  const sources = [...files(new URL('../src/features/settings/', import.meta.url)), new URL('../src/app/settings-route.tsx', import.meta.url)]
  for (const path of sources) {
    const source = readFileSync(path, 'utf8')
    const file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const module = node.moduleSpecifier?.text ?? ''
        assert.doesNotMatch(module, /(?:plugins\/|github.*connection)/i, `GitHub controls imported into ${path.pathname}`)
        assert.doesNotMatch(node.getText(file), /GithubConnection|GithubPluginScreen/, `Aliased GitHub controls in ${path.pathname}`)
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        assert.doesNotMatch(node.tagName.getText(file), /github.*(?:connection|plugin)/i, `GitHub controls rendered in ${path.pathname}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    assert.doesNotMatch(source, /\/v1\/(?:settings\/)?github/, `GitHub requests belong in Plugins, not ${path.pathname}`)
  }
})

test('route registry sends all Settings paths through the redirect boundary and owns GitHub under Plugins', () => {
  const source = read('../src/App.tsx')
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const routes = new Map()
  const visit = node => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === 'Route') {
      const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
      const path = attrs.find(attr => attr.name.getText(file) === 'path')?.initializer?.text
      const element = attrs.find(attr => attr.name.getText(file) === 'element')?.initializer?.getText(file)
      routes.set(path, element)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const [path, element] of routes) if (path?.startsWith('/settings')) assert.equal(element, '{<SettingsRoute />}', path)
  for (const path of ['/settings', '/settings/connections', '/settings/github']) assert.ok(routes.has(path), path)
  assert.equal(routes.get('/plugins/github'), '{<GithubPluginScreen />}')
  assert.match(source, /import\("@\/app\/settings-route"\)/)
  assert.match(source, /import\("@\/features\/plugins\/github-plugin"\)/)
})
