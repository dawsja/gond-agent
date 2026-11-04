import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const parse = path => ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const home = parse('../src/features/home/home-screen.tsx')
const run = parse('../src/features/run/run-screen.tsx')
const text = node => node.getText().replace(/\s+/g, ' ')
const find = (node, predicate) => {
  const found = []
  const visit = child => {
    if (predicate(child)) found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}
const component = (file, name) => {
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(declaration, `${name} must exist`)
  return declaration
}
const elements = (node, tag) => find(node, child => ts.isJsxElement(child) && child.openingElement.tagName.getText() === tag)
const stopAction = node => /stop\.mutate\s*\(/.test(text(node))
const liveCondition = node => assert.match(text(node), /const live = \w+\.status === "working" \|\| \w+\.status === "queued"/)
const stopLabel = node => assert.match(text(node), /\w+\.status === "queued" \? "Cancel" : "Stop"/)
const guardedByLive = node => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.left.getText() === 'live') return true
  }
  return false
}

test('the runs list exposes Cancel/Stop only through RunMenu', () => {
  const row = component(home, 'RunRow')
  assert.doesNotMatch(text(row), /useStopRun\s*\(/)
  assert.equal(find(row, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText() === 'RunMenu').length, 1)
  // Parse JSX rather than matching whole button blocks: catches literal labels,
  // conditional labels, aria-labels and stop handlers regardless of formatting.
  const standalone = elements(home, 'button').filter(button => stopAction(button) || find(button, node =>
    (ts.isStringLiteral(node) && /^(Cancel|Stop)$/.test(node.text)) ||
    (ts.isJsxText(node) && /\b(Cancel|Stop)\b/.test(node.text)),
  ).length)
  assert.equal(standalone.length, 0, 'Cancel/Stop must not be a standalone list button')

  const menu = component(home, 'RunMenu')
  assert.match(text(menu), /const stop = useStopRun\(\)/)
  liveCondition(menu)
  const items = elements(menu, 'MenuItem').filter(stopAction)
  assert.equal(items.length, 1, 'one menu action must retain the stop mutation')
  stopLabel(items[0])
  assert.ok(guardedByLive(items[0]), 'both queued and working runs retain the menu action')
  assert.match(text(items[0]), /onSelect=\{\(\) => stop\.mutate\(\{ id: run\.id, arg: undefined \}\)\}/)
})

test('the live run header retains its Cancel/Stop button', () => {
  const screen = component(run, 'RunScreen')
  liveCondition(screen)
  const buttons = elements(screen, 'button').filter(stopAction)
  assert.equal(buttons.length, 1)
  stopLabel(buttons[0])
  assert.ok(guardedByLive(buttons[0]))
  assert.match(text(buttons[0]), /aria-label=\{r\.status === "queued" \? "Cancel" : "Stop"\}/)
  let parent = buttons[0].parent
  while (parent && !(ts.isJsxAttribute(parent) && parent.name.getText() === 'actions')) parent = parent.parent
  assert.ok(parent, 'the live stop control belongs to the header actions')
})
