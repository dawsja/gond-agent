import { PRODUCT_NAME } from "./brand"
import { MARK_CONTENT } from "./brand-mark"

export const BRAND = {
  orange: "#e04e0a",
  ink: "#000000",
  cream: "#ededed",
} as const

export function GondAgentMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: MARK_CONTENT }} />
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
