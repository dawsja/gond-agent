interface ComposerKey {
  key: string
  shiftKey: boolean
  repeat: boolean
  keyCode: number
  nativeEvent: { isComposing: boolean }
  preventDefault: () => void
}

export function sendOnEnter(event: ComposerKey, send: () => void) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
  event.preventDefault()
  if (!event.repeat) send()
}
