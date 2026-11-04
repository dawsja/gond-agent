import { UserRound, Palette, BrainCircuit, KeyRound, UsersRound, Trash2 } from "lucide-react"

// One topic owns each section, its bookmarks and its search vocabulary.
export const SETTINGS_PAGES = [
  { id: "account", title: "Account", route: "/settings/account", adminOnly: false, icon: UserRound, sections: [
    { id: "account", title: "Account", adminOnly: false, anchors: ["personal-settings"], keywords: "profile photo name email preferences" },
    { id: "sign-in-methods", title: "Sign-in methods", adminOnly: false, anchors: ["security-settings"], keywords: "password identity link single sign-on" },
    { id: "sessions", title: "Sessions", adminOnly: false, anchors: [], keywords: "sign out revoke devices browsers" },
  ] },
  { id: "appearance", title: "Appearance", route: "/settings/appearance", adminOnly: false, icon: Palette, sections: [
    { id: "appearance", title: "Appearance", adminOnly: false, anchors: [], keywords: "theme color accent system light dark" },
  ] },
  { id: "models", title: "Models", route: "/settings/models", adminOnly: false, icon: BrainCircuit, sections: [
    { id: "chatgpt", title: "ChatGPT plan", adminOnly: false, anchors: ["model-settings"], keywords: "subscription usage limits sign in" },
    { id: "providers", title: "Model providers", adminOnly: true, anchors: [], keywords: "api key url anthropic openai models setup" },
  ] },
  { id: "agent-access", title: "Agent access", route: "/settings/agent-access", adminOnly: false, icon: KeyRound, sections: [
    { id: "web-search", title: "Web search", adminOnly: true, anchors: [], keywords: "brave tavily search provider key" },
    { id: "mcp", title: "MCP access", adminOnly: false, anchors: ["agent-access-settings"], keywords: "token endpoint tools access" },
  ] },
  { id: "sign-in-people", title: "Sign-in & people", route: "/settings/sign-in-people", adminOnly: true, icon: UsersRound, sections: [
    { id: "oidc", title: "Single sign-on", adminOnly: true, anchors: [], keywords: "openid connect identity provider security" },
    { id: "people", title: "People", adminOnly: true, anchors: ["people-settings"], keywords: "members roles administrator permissions" },
  ] },
  { id: "danger-zone", title: "Danger zone", route: "/settings/danger-zone", adminOnly: false, icon: Trash2, sections: [
    { id: "delete", title: "Delete account", adminOnly: false, anchors: ["account-management-settings"], keywords: "remove erase close" },
  ] },
] as const

export type SettingsPage = (typeof SETTINGS_PAGES)[number]
export type SettingsSectionId = SettingsPage["sections"][number]["id"]

// These retired sections belong to Plugins, never a Settings panel.
export const SETTINGS_EXTERNAL_REDIRECTS = [
  { anchors: ["connections", "connections-settings", "github", "shared-github"], route: "/plugins/github" },
] as const

export function settingsPages(admin: boolean) {
  return SETTINGS_PAGES.filter(page => admin || !page.adminOnly)
}

export function settingsHref(id: SettingsSectionId) {
  const page = SETTINGS_PAGES.find(page => page.sections.some(section => section.id === id))!
  return `${page.route}#${id}`
}

export function settingsSearchItems(admin: boolean) {
  return settingsPages(admin).flatMap(page => page.sections.filter(section => admin || !section.adminOnly).map(section => ({
    title: section.title, to: settingsHref(section.id), icon: page.icon, keywords: `${page.title} ${section.keywords}`,
  })))
}

/** Canonicalize old hashes, category anchors, query links and section paths. Keep OAuth errors intact. */
export function resolveSettingsLocation(pathname: string, hash: string, search: string, admin: boolean) {
  const query = new URLSearchParams(search)
  const path = pathname.replace(/^\/settings\/?/, "").replace(/\/$/, "")
  const targets = [hash.slice(1), ...["section", "tab", "anchor"].map(key => query.get(key) ?? ""), SETTINGS_PAGES.some(page => page.id === path) ? "" : path].map(value => value.toLowerCase())
  const external = SETTINGS_EXTERNAL_REDIRECTS.find(item => targets.some(target => item.anchors.some(anchor => anchor === target)))
  if (external) return { to: external.route, page: SETTINGS_PAGES[0], anchor: "", external: true }

  let page: SettingsPage = SETTINGS_PAGES.find(page => page.id === path) ?? SETTINGS_PAGES[0]
  let anchor = ""
  for (const target of targets) {
    if (!target) continue
    const owner = SETTINGS_PAGES.find(page => page.sections.some(section => section.id === target || section.anchors.some(alias => alias === target)))
    if (owner) {
      const section = owner.sections.find(section => section.id === target || section.anchors.some(alias => alias === target))!
      page = owner
      if (admin || !section.adminOnly) anchor = section.id
      break
    }
    const topic = SETTINGS_PAGES.find(page => page.id === target)
    if (topic) { page = topic; break }
  }
  if (page.adminOnly && !admin) { page = SETTINGS_PAGES[0]; anchor = "" }
  for (const key of ["section", "tab", "anchor"]) query.delete(key)
  const suffix = query.size ? `?${query}` : ""
  return { to: `${page.route}${suffix}${anchor ? `#${anchor}` : ""}`, page, anchor, external: false }
}
