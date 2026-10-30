import { PRODUCT_NAME } from "./brand"
import { CLOUD_PATH, CLOUD_TRANSFORM, MARK_INK } from "./brand-mark"

export const BRAND = {
  orange: "#e04e0a",
  ink: "#000000",
  cream: "#ededed",
} as const

/** The canonical cloud mascot silhouette in a white circle, with no eyes or animation. */
export function GondAgentMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true">
      <circle cx="50" cy="50" r="50" fill="#ffffff" />
      <path transform={CLOUD_TRANSFORM} d={CLOUD_PATH} fill={MARK_INK} stroke={MARK_INK} strokeWidth="5" strokeLinejoin="round" />
    </svg>
  )
}

export function GondAgentLockup({ height = 24, className }: { height?: number; className?: string }) {
  return (
    <span className={className} style={{ display: "inline-flex", alignItems: "center", gap: height * 0.35, whiteSpace: "nowrap", lineHeight: 1 }}>
      <GondAgentMark size={height} />
      <span style={{ fontFamily: "Inter, sans-serif", fontSize: height * 0.75, fontWeight: 600, letterSpacing: "-0.03em" }}>{PRODUCT_NAME}</span>
    </span>
  )
}
