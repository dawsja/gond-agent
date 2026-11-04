/** Shared bounds/range calculation. Offset pages stay numbered during live updates. */
export const PAGE_SIZES = [10, 25, 50, 100] as const
export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

export function decimal(value: unknown, fallback: number): number {
  if (typeof value !== "number" && typeof value !== "string") return fallback
  if (!/^\d+$/.test(String(value))) return fallback
  const n = Number(value)
  return Number.isSafeInteger(n) ? n : fallback
}

export function pageSize(value: unknown): number {
  const n = decimal(value, DEFAULT_PAGE_SIZE)
  return PAGE_SIZES.some(size => size === n) ? n : DEFAULT_PAGE_SIZE
}

export function pagination(total: number, limit: number, requestedOffset: number) {
  const offset = requestedOffset < total ? requestedOffset : Math.max(0, Math.ceil(total / limit) - 1) * limit
  return { total, limit, offset, start: total ? offset + 1 : 0, end: Math.min(offset + limit, total) }
}

/** Defense at the rendering boundary, not a substitute for server pagination. */
export function pageRows<T>(rows: T[], size: number): T[] {
  return rows.slice(0, pageSize(size))
}

export function homePage(search: URLSearchParams, rememberedSize: string | null) {
  const size = pageSize(search.has("size") ? search.get("size") : rememberedSize)
  const page = Math.max(1, decimal(search.get("page"), 1))
  // Keep multiplication safe before passing the offset to the API.
  return { size, page: Math.min(page, Math.floor(Number.MAX_SAFE_INTEGER / size)) }
}
