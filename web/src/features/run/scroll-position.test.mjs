import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { isPinned, showScrollToBottom } from "./scroll-position.ts"

const source = name => readFileSync(new URL(name, import.meta.url), "utf8")

test("visibility uses 120/80px hysteresis, including exact boundaries and no overflow", () => {
  for (const previous of [false, true]) {
    for (const distance of [-10, 0, 79, 80]) assert.equal(showScrollToBottom(distance, previous), false)
    for (const distance of [80.1, 100, 120]) assert.equal(showScrollToBottom(distance, previous), previous)
    assert.equal(showScrollToBottom(120.1, previous), true)
  }
  assert.equal(showScrollToBottom(50, false, 20, 40), true)
  assert.equal(showScrollToBottom(20, true, 20, 40), false)
})

test("following retains the original strict 80px pinned boundary", () => {
  assert.equal(isPinned(0), true)
  assert.equal(isPinned(79.9), true)
  assert.equal(isPinned(80), false)
  assert.equal(isPinned(120), false)
})

test("the control is labelled, theme-token-only and uses the existing square-control radius", () => {
  const button = source("./scroll-to-bottom-button.tsx")
  const controls = source("../studio/theme.tsx")
  assert.match(button, /aria-label="Scroll to bottom"/)
  assert.match(button, /inert=\{!shown\}/)
  assert.match(button, /tabIndex=\{shown \? 0 : -1\}/)
  assert.match(button, /focus-visible:ring-ring/)
  assert.match(button, /motion-reduce:transition-opacity/)
  assert.match(button, /rounded-\[4px\]/)
  assert.match(controls, /rounded-\[4px\]/)
  assert.doesNotMatch(button, /rounded-full|#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(/i)
})
