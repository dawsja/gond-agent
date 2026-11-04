import { useCallback, useLayoutEffect, useRef, useState } from "react"
import { isPinned, showScrollToBottom } from "./scroll-position"

/** Scroll geometry stays in refs; React only hears about visibility changes. */
export function useStickToBottom(update: unknown, ready: boolean) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const distance = useRef(0)
  const resuming = useRef(false)
  const visible = useRef(false)
  const [shown, setShown] = useState(false)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [update, ready])

  useLayoutEffect(() => {
    const el = scroller.current, body = content.current, input = composer.current
    if (!el || !body || !input) return
    let frame = 0
    let height = el.scrollHeight, viewport = el.clientHeight
    const measure = () => {
      frame = 0
      const resized = height !== el.scrollHeight || viewport !== el.clientHeight
      height = el.scrollHeight
      viewport = el.clientHeight
      // rAF runs before ResizeObserver delivery. Do not mistake a content/composer
      // resize (or its clamped scroll event) for the reader scrolling away.
      if (resized && pinned.current && !resuming.current) el.scrollTop = height
      distance.current = Math.max(0, height - el.scrollTop - viewport)
      // A smooth jump produces intermediate scroll events far from the end.
      // Those must not cancel the explicit choice to resume following.
      if (distance.current <= 1) resuming.current = false
      if (!resuming.current) pinned.current = isPinned(distance.current)
      const next = showScrollToBottom(distance.current, visible.current)
      if (next !== visible.current) {
        visible.current = next
        setShown(next)
      }
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const interrupt = () => { resuming.current = false; schedule() }
    const settled = () => { resuming.current = false; schedule() }
    const resized = new ResizeObserver(() => {
      input.parentElement?.style.setProperty("--composer-h", `${input.getBoundingClientRect().height}px`)
      schedule()
    })
    resized.observe(el)
    resized.observe(body)
    resized.observe(input)
    el.addEventListener("scroll", schedule, { passive: true })
    el.addEventListener("scrollend", settled, { passive: true })
    for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) el.addEventListener(event, interrupt, { passive: true })
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      resized.disconnect()
      el.removeEventListener("scroll", schedule)
      el.removeEventListener("scrollend", settled)
      for (const event of ["wheel", "touchstart", "pointerdown", "keydown"]) el.removeEventListener(event, interrupt)
    }
  }, [ready])

  const resumeFollowing = useCallback(() => { pinned.current = true }, [])

  const scrollToBottom = useCallback(() => {
    const el = scroller.current
    if (!el) return
    pinned.current = true
    resuming.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })
  }, [])

  return { scroller, content, composer, resumeFollowing, shown, scrollToBottom }
}
