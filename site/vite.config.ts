import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite"

// Dev only: /__frame?src=/path&w=390&h=844 renders the page in an iframe of exactly that size, so
// shot.sh can capture phone layouts (headless Edge won't make a window narrower than ~484px).
const phoneFrame = (): Plugin => ({
  name: "gond-agent-phone-frame",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__frame", (req, res) => {
      const q = new URL(req.url ?? "", "http://x").searchParams
      const src = (q.get("src") ?? "/").replace(/[<>"']/g, "")
      const w = Number(q.get("w")) || 390
      const h = Number(q.get("h")) || 844
      res.setHeader("content-type", "text/html")
      res.end(`<!doctype html><body style="margin:0;background:#000"><iframe src="${src}" style="border:0;width:${w}px;height:${h}px"></iframe>`)
    })
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), phoneFrame()],
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), resolve(import.meta.dirname, "../shared")] }, port: 5190 },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      // Code shared by the web app and the landing page (the repo root\'s shared/).
      "@shared": resolve(import.meta.dirname, "../shared"),
    },
    // shared/ has no node_modules: its imports resolve from this app\'s.
    dedupe: ["react", "react-dom", "clsx", "tailwind-merge", "lucide-react", "radix-ui", "react-markdown", "remark-gfm"],
  },
})
