import { DEFAULT_ACCENT, isAccent, type Accent } from "@shared/accents"

const CACHE_KEY = "gond-agent-accent"

/** A first-frame hint only; the account response always replaces it. */
export function cachedAccent(): Accent {
  try {
    const value = localStorage.getItem(CACHE_KEY)
    return isAccent(value) ? value : DEFAULT_ACCENT
  } catch {
    return DEFAULT_ACCENT
  }
}

export function applyAccent(accent: Accent) {
  document.documentElement.dataset.accent = accent
  try { localStorage.setItem(CACHE_KEY, accent) } catch { /* Storage may be disabled. */ }
}
