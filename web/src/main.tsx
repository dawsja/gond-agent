import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"
import { applyTheme, followSystemTheme, readStoredTheme, resolveTheme } from "@/lib/theme"

const theme = readStoredTheme()
applyTheme(resolveTheme(theme), theme)
followSystemTheme()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
