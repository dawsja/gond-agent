// Ordered account accent choices. Palette tokens live in web/src/index.css.
export const ACCENTS = ["blue", "purple", "pink", "red", "orange", "amber", "green"] as const
export type Accent = typeof ACCENTS[number]
export const DEFAULT_ACCENT: Accent = "blue"
export const ACCENT_LABELS: Record<Accent, string> = {
  blue: "Blue", purple: "Purple", pink: "Pink", red: "Red", orange: "Orange", amber: "Amber", green: "Green",
}
export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && ACCENTS.some(accent => accent === value)
}
