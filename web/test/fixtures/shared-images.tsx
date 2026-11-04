import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TranscriptView } from "@/features/run/transcript-view"
import { createTranscript } from "@/features/run/transcript"
import type { Run } from "@/lib/api"
import "@/index.css"

const params = new URLSearchParams(location.search)
document.documentElement.classList.toggle("dark", params.get("theme") === "dark")
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
// A local PNG fixture stands in for the authenticated image endpoint, not Markdown.
const canvas = document.createElement("canvas")
canvas.width = 1440; canvas.height = 750
const ctx = canvas.getContext("2d")!
ctx.fillStyle = "#f4f1eb"; ctx.fillRect(0, 0, 1440, 750)
ctx.fillStyle = "#1b1a18"; ctx.font = "bold 42px sans-serif"; ctx.fillText("Home", 90, 100)
ctx.font = "24px sans-serif"; ctx.fillText("Runs", 90, 165)
for (let i = 0; i < 5; i++) {
  ctx.fillStyle = "white"; ctx.fillRect(90, 205 + i * 80, 1260, 65)
  ctx.fillStyle = "#1b1a18"; ctx.font = "22px sans-serif"; ctx.fillText(["Paginate the Home runs list", "Review open changes", "Update project documentation", "Check mobile layout", "Improve search results"][i], 115, 246 + i * 80)
  ctx.fillStyle = "#375b3c"; ctx.fillText("Ready", 1200, 246 + i * 80)
}
ctx.fillStyle = "#1b1a18"; ctx.font = "22px sans-serif"; ctx.fillText("1–10 of 28 runs", 90, 690); ctx.fillText("1     2     3     Next →", 1080, 690)
canvas.toBlob(blob => {
  client.setQueryData(["run-image", "fixture", "img_fixture"], blob)
  client.setQueryData(["me"], { user: { id: "owner", name: "Daws" } })
  const transcript = createTranscript()([
    { type: "user", text: "Show the desktop pagination screenshot.", seq: 1, ts: Date.now() },
    { type: "text.delta", agent_id: "main", text: "Here is the desktop pagination view.", seq: 2, ts: Date.now() },
    { type: "image.shared", agent_id: "main", image_id: "img_fixture", media_type: "image/png", caption: "Desktop Home pagination — 10 runs per page", seq: 3, ts: Date.now() },
    { type: "text.delta", agent_id: "main", text: "Local paths cannot be loaded: ![Mobile pagination](/tmp/mobile.png)\n\n![Remote screenshot](https://example.test/private.png)", seq: 4, ts: Date.now() },
    { type: "run.status", status: "ready", seq: 5, ts: Date.now() },
  ])
  const run = { id: "fixture", user_id: "owner", repo: "acme/app", base_branch: "main", status: "ready", created_at: Date.now() } as Run
  createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><main className="min-h-screen bg-background text-foreground"><TranscriptView run={run} t={transcript} author="Daws" /></main></QueryClientProvider>)
}, "image/png")
