import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? files(new URL(`${entry.name}/`, dir)) : entry.name.endsWith('.tsx') ? [new URL(entry.name, dir)] : [])

// Settings also renders GitHub from plugins; saved schedules live in automations.
const sources = ['settings', 'plugins', 'automations'].flatMap(dir => files(new URL(`../src/features/${dir}/`, import.meta.url)))

test('boolean settings use the shared Switch, not checkboxes or local switches', () => {
  for (const path of sources) {
    const source = readFileSync(path, 'utf8')
    const file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const checkboxes = new Set(['Checkbox'])
    for (const statement of file.statements) {
      if (!ts.isImportDeclaration(statement)) continue
      const bindings = statement.importClause?.namedBindings
      if (!bindings || !ts.isNamedImports(bindings)) continue
      for (const binding of bindings.elements) {
        const imported = (binding.propertyName ?? binding.name).text
        if (imported === 'Checkbox') checkboxes.add(binding.name.text)
        if (imported === 'Switch') assert.equal(statement.moduleSpecifier.text, '@shared/ui/switch', path.pathname)
      }
    }
    const visit = node => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'Switch') assert.fail(`Local Switch in ${path.pathname}`)
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(file)
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
        const checkbox = checkboxes.has(tag) || attrs.some(attr => attr.name.getText(file) === 'type' && /["']checkbox["']/.test(attr.initializer?.getText(file) ?? ''))
        assert.ok(!attrs.some(attr => attr.name.getText(file) === 'role' && /["']switch["']/.test(attr.initializer?.getText(file) ?? '')), `Use shared Switch in ${path.pathname}`)
        if (checkbox) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line
          // Only genuine choose-several lists may opt out, with a nearby rationale.
          const nearby = source.split('\n').slice(Math.max(0, line - 1), line + 1).join('\n')
          assert.match(nearby, /settings-multiselect: .+/, `Boolean checkbox in ${path.pathname}:${line + 1}; use shared Switch`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
})
