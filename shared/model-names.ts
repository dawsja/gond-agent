/** Format versioned Claude IDs without maintaining a model/version catalog. */
export function modelDisplayName(name: string, id: string, resolved?: string): string {
  const concrete = resolved || id
  const identifier = concrete.slice(concrete.lastIndexOf("/") + 1).replace(/-\d{8}(?=$|\[)/, "")
  const current = /^claude-([a-z][a-z-]*)-(\d+(?:[.-]\d+)*)(\[[^\]]+\])?$/i.exec(identifier)
  const legacy = /^claude-(\d+(?:[.-]\d+)*)-([a-z][a-z-]*)(\[[^\]]+\])?$/i.exec(identifier)
  const family = current?.[1] ?? legacy?.[2]
  const version = current?.[2] ?? legacy?.[1]
  if (!family || !version) return /\d/.test(name) ? name : resolved || name || id
  const full = `Claude ${family.replace(/-/g, " ").replace(/\b[a-z]/g, letter => letter.toUpperCase())} ${version.replace(/-/g, ".")}${current?.[3] ?? legacy?.[3] ?? ""}`
  if (resolved) return `${full}${!id || id === "default" ? " (default)" : ""}`
  // Preserve the provider's advertised full name and custom administrator labels.
  if (name === concrete || name === identifier) return full
  if (name.includes(version.replace(/-/g, "."))) return name
  if (!name || name.toLowerCase().replace(/^claude /, "") === family.replace(/-/g, " ").toLowerCase()) return full
  return `${name} (${full})`
}
