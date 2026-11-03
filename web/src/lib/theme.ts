import { DEFAULT_THEME, isTheme, DARK_QUERY, THEME_STORAGE_KEY, type Theme } from "../../../shared/theme-preference"

export { DARK_QUERY, THEME_STORAGE_KEY }
export type ResolvedTheme = "light" | "dark"

export function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : DEFAULT_THEME
  } catch { return DEFAULT_THEME }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === "system" ? (window.matchMedia(DARK_QUERY).matches ? "dark" : "light") : theme
}

export function applyTheme(resolved: ResolvedTheme, theme: Theme = resolved) {
  const root = document.documentElement
  root.classList.toggle("dark", resolved === "dark")
  root.dataset.theme = theme
  root.style.colorScheme = resolved
  // Read the palette, not a second set of colors in JavaScript.
  document.querySelectorAll('meta[name="theme-color"]').forEach(meta => {
    meta.setAttribute("content", getComputedStyle(root).getPropertyValue("--background").trim())
  })
}

/** The server is authoritative; this copy only paints the next load before /me answers. */
export function setTheme(theme: Theme) {
  applyTheme(resolveTheme(theme), theme)
  try { window.localStorage.setItem(THEME_STORAGE_KEY, theme) } catch { /* Storage may be disabled. */ }
}

export function followSystemTheme() {
  const media = window.matchMedia(DARK_QUERY)
  const onChange = () => {
    if (document.documentElement.dataset.theme === "system") applyTheme(resolveTheme("system"), "system")
  }
  media.addEventListener("change", onChange)
  return () => media.removeEventListener("change", onChange)
}
