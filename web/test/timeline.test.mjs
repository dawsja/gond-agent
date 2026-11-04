import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const cache = new Map()
function load(path) {
  if (cache.has(path.href)) return cache.get(path.href)
  const exports = {}; cache.set(path.href, exports)
  const source = readFileSync(path, 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'exports', code)(name => name.startsWith('.') ? load(new URL(name + '.ts', path)) : require(name), exports)
  return exports
}
const { groupTranscriptItems } = load(new URL('../src/features/run/group-transcript.ts', import.meta.url))
const { createTranscript } = load(new URL('../src/features/run/transcript.ts', import.meta.url))
const { activityLabel, presentTool } = load(new URL('../src/features/run/tool-presentation.ts', import.meta.url))
const call = (id, name = 'bash', status = 'done', input = { command: 'npm test' }) => ({ callId: id, ...presentTool(name, '', input), status, output: '', summary: '', start: 1 })
const item = tool => ({ kind: 'tool', key: tool.callId, tool })
const group = tools => groupTranscriptItems(tools.map(item))

test('empty and single completed activity, without mutating frozen inputs', () => {
  assert.deepEqual(groupTranscriptItems([]), [])
  const tool = call('first'); Object.freeze(tool.paths); Object.freeze(tool)
  const input = Object.freeze([Object.freeze(item(tool))])
  const [row] = groupTranscriptItems(input)
  assert.equal(row.label, 'Ran 1 command')
  assert.equal(row.detail, 'npm test')
  assert.equal(row.tools[0], tool)
})

test('only consecutive kinds collapse, preserving chronological steps and check separators', () => {
  const rows = group([call('a'), call('b'), call('c', 'edit', 'done', { path: 'api/src/runs/service.ts' }), call('d'), call('e', 'run_checks'), call('f')])
  assert.deepEqual(rows.map(row => row.kind === 'activity-group' ? row.activity : row.tool.name), ['commands', 'edits', 'commands', 'run_checks', 'commands'])
  assert.equal(rows[0].label, 'Ran 2 commands')
  assert.equal(rows[1].label, 'Edited 1 file')
  assert.equal(rows[1].detail, 'api/src/runs/service.ts')
  assert.deepEqual(rows[0].tools.map(t => t.callId), ['a', 'b'])
})

test('only the second command fails: collapsed detail names the first failure, not the first command', () => {
  const failed = { ...call('bad', 'bash', 'failed', { command: 'npm run build' }), output: 'Permission denied' }
  const [row] = group([call('a'), failed])
  assert.equal(row.label, 'Ran 2 commands')
  assert.equal(row.failed, 1)
  assert.equal(row.detail, 'npm run build')
  assert.equal(row.tools[1].output, 'Permission denied')
  const [moreFailures] = group([call('a'), failed, call('bad2', 'bash', 'failed', { command: 'git diff --check' })])
  assert.equal(moreFailures.failed, 2)
  assert.equal(moreFailures.detail, 'npm run build')
})

test('collapsed command detail strips display controls, bidi, tags and variation selectors without changing raw details', () => {
  const command = 'printf \u202E\u200B\u2066ok\u2069\u{E0000}\u{E0061}\u{E007F}\uFE0F\u{E0100}\u0000\u001B\u007F\u0085\t\n'
  const tool = call('unsafe', 'bash', 'done', { command })
  Object.freeze(tool.paths); Object.freeze(tool)
  const [row] = group([tool])
  assert.equal(row.detail, 'printf ok')
  assert.equal(row.tools[0], tool)
  assert.equal(row.tools[0].title, command, 'expanded details retain the original command')
})

test('stable first-call ID retains keyed expansion as terminal steps append', () => {
  const [before] = group([call('a')])
  const expanded = new Map([[before.key, true]])
  const [after] = group([call('a'), call('b'), call('c', 'bash', 'failed')])
  assert.equal(after.key, before.key)
  assert.equal(expanded.get(after.key), true)
  assert.equal(after.tools.length, 3)
  assert.equal(after.failed, 1)
})

test('live commands are standalone until done, then join the preceding group', () => {
  const live = item(call('live', 'bash', 'running'))
  const before = groupTranscriptItems([item(call('a')), live])
  assert.equal(before.length, 2)
  assert.equal(before[1].tool, live.tool)
  assert.equal(before[1].expansionKey, 'activity:commands:live')
  const after = group([call('a'), call('live')])
  assert.equal(after.length, 1)
  assert.equal(after[0].key, before[0].key)
  assert.ok(after[0].expansionKeys.includes(before[1].expansionKey), 'an open live row transfers its disclosure state')
})

test('flattens old folded explore/edit batches, separates live members, deduplicates file counts', () => {
  const read = call('r', 'Read', 'done', { file_path: 'a.ts' })
  const review = call('review', 'batch', 'done', {})
  const live = call('live', 'read', 'running', { path: 'b.ts' })
  const [soloLive] = groupTranscriptItems([{ kind: 'explore', key: 'x1', tools: [live] }])
  const [appendedLive] = groupTranscriptItems([{ kind: 'explore', key: 'x1', tools: [live, call('next', 'read', 'running')] }])
  assert.equal(soloLive.key, appendedLive.key)
  const rows = groupTranscriptItems([{ kind: 'explore', key: 'x1', tools: [read, review, live] }])
  assert.equal(rows[0].label, 'Explored 1 file')
  assert.deepEqual(rows[0].tools, [read, review])
  assert.equal(rows[1].kind, 'tool')
  assert.equal(rows[1].tool, live)
  const [edits] = group([call('e1', 'Edit', 'done', { path: 'a.ts' }), call('e2', 'write', 'done', { path: 'a.ts' }), call('e3', 'fileChange', 'done', { changes: [{ path: 'b.ts' }] })])
  assert.equal(edits.label, 'Edited 2 files')
  assert.equal(group([review])[0].label, 'Explored context · 1 step')
})

test('out-of-order parallel completion retains all stable disclosure membership keys', () => {
  const a = call('a', 'read', 'running', { path: 'a.ts' })
  const b = call('b', 'read', 'done', { path: 'b.ts' })
  const before = groupTranscriptItems([{ kind: 'explore', key: 'x1', tools: [a, b] }])
  const expanded = new Set([before[1].key])
  const [after] = groupTranscriptItems([{ kind: 'explore', key: 'x1', tools: [{ ...a, status: 'done' }, b] }])
  assert.ok(after.expansionKeys.some(key => expanded.has(key)))
  assert.deepEqual(after.tools.map(t => t.callId), ['a', 'b'])
  assert.equal(after.label, 'Explored 2 files')
})

test('legacy missing metadata, unknown/external tools, and other items pass through as separators', () => {
  const unknown = item(call('unknown', 'future_tool'))
  const legacy = item({ ...call('old'), title: '', paths: [] })
  const external = item(call('ext', 'mcp__remote__bash'))
  const text = { kind: 'text', key: 't', text: 'A message' }
  const future = { kind: 'future', key: 'future' }
  const rows = groupTranscriptItems([item(call('a')), unknown, legacy, external, text, future, item(call('b'))])
  assert.deepEqual(rows.slice(1, -1), [unknown, legacy, external, text, future])
  assert.equal(rows[0].tools.length, 1)
  assert.equal(rows.at(-1).tools.length, 1)
})

test('grouping streamed snapshots matches replay, including legacy aliases and live explores', () => {
  const events = [
    { type: 'tool.start', call_id: 'a', name: 'commandExecution', input: { command: 'pwd' } },
    { type: 'tool.end', call_id: 'a', ok: true },
    { type: 'tool.start', call_id: 'b', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool.end', call_id: 'b', ok: true },
    { type: 'tool.start', call_id: 'c', name: 'read', input: { path: 'a.ts' } },
    { type: 'tool.end', call_id: 'c', ok: true },
    { type: 'tool.start', call_id: 'd', name: 'read', input: { path: 'b.ts' } },
  ].map((event, index) => ({ ...event, seq: index + 1, ts: index + 1 }))
  const fold = createTranscript()
  for (const event of events) fold([event])
  assert.deepEqual(groupTranscriptItems(fold([]).items), groupTranscriptItems(createTranscript()(events).items))
  const rows = groupTranscriptItems(fold([]).items)
  assert.equal(rows[0].tools.length, 2)
  assert.equal(rows[1].label, 'Explored 1 file')
  assert.equal(rows[2].tool.status, 'running')
})

test('model retries stay visible separators across commands, edits and exploration, streaming and replay', () => {
  for (const [name, input] of [['bash', { command: 'pwd' }], ['edit', { path: 'a.ts' }], ['read', { path: 'a.ts' }]]) {
    const events = [
      { type: 'run.status', status: 'working' },
      { type: 'tool.start', call_id: 'before', name, input },
      { type: 'tool.end', call_id: 'before', ok: true },
      { type: 'text.delta', text: 'Discarded partial response' },
      { type: 'model.retry', attempt: 2, max_attempts: 5, wait_seconds: 7.2 },
      { type: 'stream.reset', text_length: 'Discarded partial response'.length },
      { type: 'model.retry', agent_id: 'helper', attempt: 2, max_attempts: 5, wait_seconds: 20 },
      { type: 'tool.start', call_id: 'middle', name, input },
      { type: 'model.retry', attempt: 3, max_attempts: 5, wait_seconds: 0 },
      { type: 'tool.end', call_id: 'middle', ok: true },
      { type: 'tool.start', call_id: 'after', name, input },
      { type: 'tool.end', call_id: 'after', ok: true },
      { type: 'text.delta', text: 'Recovered response' },
    ].map((event, index) => ({ agent_id: 'main', ...event, seq: index + 1, ts: index + 1 }))
    const fold = createTranscript()
    let duringRetry
    for (const event of events) {
      const snapshot = fold([event])
      if (event.seq === 9) duringRetry = groupTranscriptItems(snapshot.items)
    }
    const transcript = fold([])
    const rows = groupTranscriptItems(transcript.items)
    assert.deepEqual(rows, groupTranscriptItems(createTranscript()(events).items), name)
    assert.equal(transcript.status, 'working')
    assert.deepEqual(rows.map(row => row.kind), ['activity-group', 'run-message', 'activity-group', 'run-message', 'activity-group', 'text'], name)
    assert.deepEqual(rows.filter(row => row.kind === 'activity-group').map(row => row.tools.map(tool => tool.callId)), [['before'], ['middle'], ['after']])
    const messages = rows.filter(row => row.kind === 'run-message')
    assert.deepEqual(messages.map(row => row.text), ['Retrying in 8 s (attempt 2 of 5)', 'Retrying in 0 s (attempt 3 of 5)'])
    assert.deepEqual(messages.map(row => row.key), duringRetry.filter(row => row.kind === 'run-message').map(row => row.key))
    assert.equal(duringRetry.find(row => row.kind === 'tool').tool.status, 'running', 'later completion cannot mutate an earlier snapshot')
    assert.equal(rows.at(-1).text, 'Recovered response')
  }
})

test('check names remain detailed and report exit status, never a verification verdict', () => {
  const check = call('check', 'run_checks')
  assert.equal(check.title, 'npm test')
  assert.equal(activityLabel(check), 'Checks finished')
  assert.equal(activityLabel({ ...check, summary: '1.2s', output: 'No type errors.' }), 'Checks finished · exit 0')
  const trivial = call('trivial', 'run_checks', 'done', { command: 'true' })
  assert.equal(activityLabel({ ...trivial, summary: '0.0s' }), 'Checks finished · exit 0')
  assert.equal(activityLabel({ ...check, summary: 'background · bg-1' }), 'Checks finished')
  assert.equal(activityLabel({ ...check, output: '{"exit_code":0}' }), 'Checks finished')
  assert.equal(activityLabel({ ...check, status: 'failed' }), 'Checks failed')
  assert.equal(activityLabel({ ...check, status: 'failed', summary: 'exit 2 · 0.2s' }), 'Checks failed · exit 2')
  assert.equal(activityLabel({ ...check, status: 'failed', summary: 'timed out after 30s' }), 'Checks failed')
  assert.equal(activityLabel({ ...check, status: 'running' }), 'Running checks')
  assert.equal(group([call('a'), check, call('b')]).length, 3)
})

test('transcript view renders activity exclusively through the pure grouping boundary', () => {
  const source = readFileSync(new URL('../src/features/run/transcript-view.tsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ groupTranscriptItems,.*from "\.\/group-transcript"/)
  assert.match(source, /const timeline = useMemo\(\(\) => groupTranscriptItems\(t.items\), \[t.items\]\)/)
  assert.match(source, /\{timeline.map\(render\)\}/)
  assert.doesNotMatch(source, /t.items.map\(render\)/)
  assert.match(source, /case "activity-group":[\s\S]*?activity=\{it\}/)
})
