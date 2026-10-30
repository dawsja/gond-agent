import { useCallback, useEffect, useRef, useState } from "react"

/** Copies text, then reports `copied` for a moment so the control can confirm. */
export function useCopy(text: string) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const field = document.createElement("textarea")
      field.value = text
      field.setAttribute("readonly", "")
      field.style.position = "fixed"
      field.style.opacity = "0"
      document.body.appendChild(field)
      field.select()
      document.execCommand("copy")
      field.remove()
    }
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2200)
  }, [text])
  return { copied, copy }
}
