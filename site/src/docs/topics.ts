import introduction from "./content/introduction.md?raw"
import selfHosting from "./content/self-hosting.md?raw"
import account from "./content/account.md?raw"
export type Topic = { slug: string; title: string; lead: string; body: string }
export const GROUPS = [{ label: "Gond Agent", topics: [
  { slug: "introduction", title: "Introduction", lead: "Coding agents on your own infrastructure.", body: introduction },
  { slug: "self-hosting", title: "Self-hosting", lead: "Build the containers, start the server and connect GitHub.", body: selfHosting },
  { slug: "account", title: "Account and sign-in", lead: "Email, password, sessions and OpenID Connect.", body: account },
] }]
export const TOPICS = GROUPS.flatMap(g => g.topics)
export const topicFor = (path: string): Topic => TOPICS.find(t => t.slug === path.replace(/^\/docs\/?/, "").split("/")[0]) ?? TOPICS[0]!
export const sectionsOf = (body: string) => [...body.matchAll(/^## (.+)$/gm)].map(m => m[1]!.trim())
