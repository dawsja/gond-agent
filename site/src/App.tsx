import { lazy, Suspense } from "react"

const Landing = lazy(() => import("./landing"))
const Legal = lazy(() => import("./legal/page"))
const Docs = lazy(() => import("./docs/page"))

// A few pages, so no router: the landing page, the docs (/docs/<topic>), and the Terms and Privacy.
export default function App() {
  const path = location.pathname.replace(/\/+$/, "") || "/"
  const page =
    path === "/terms" ? (
      <Legal doc="terms" />
    ) : path === "/privacy" ? (
      <Legal doc="privacy" />
    ) : path === "/docs" || path.startsWith("/docs/") ? (
      <Docs path={path} />
    ) : (
      <Landing />
    )
  return <Suspense fallback={null}>{page}</Suspense>
}
