import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin, searchForWorkspaceRoot } from "vite"
import { themeInitScript } from "../shared/theme-preference.ts"

// Generate first-paint colors from the source palettes, never a second hardcoded palette.
function firstPaintScript() {
  const css = readFileSync(new URL("./src/index.css", import.meta.url), "utf8")
  const background = (selector: string) => {
    const value = css.match(new RegExp(`(?:^|\\n)${selector} \\{[^}]*?--background:\\s*(#[\\da-f]{6});`, "i"))?.[1]
    if (!value) throw new Error(`Missing ${selector} background for theme bootstrap`)
    return value
  }
  return themeInitScript({ light: background(":root"), dark: background("\\.dark") })
}

// Dev only: /__frame?src=/path&w=390&h=844 renders the app in an iframe of exactly that size, so
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

// https://vite.dev/config/
export default defineConfig({
  base: "/agents/",
  plugins: [react(), tailwindcss(), phoneFrame(), {
    name: "gond-agent-first-paint-theme",
    transformIndexHtml: { order: "pre", handler: html => html.replace("<!--theme-init-->", `<script>${firstPaintScript()}</script>`) },
  }],
  server: {
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), resolve(import.meta.dirname, "../shared")] },
    port: 5180,
    proxy: {
      "/api": { target: "http://localhost:8787",  },
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      "@shared": resolve(import.meta.dirname, "../shared"),
    },
    // shared/ has no node_modules: its imports resolve from this app\'s.
    dedupe: ["react", "react-dom", "clsx", "tailwind-merge", "lucide-react", "radix-ui", "react-markdown", "remark-gfm"],
  },
})
