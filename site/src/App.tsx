import { lazy, Suspense } from "react"

const Landing = lazy(() => import("./landing"))
const Legal = lazy(() => import("./legal/page"))

// Landing, Terms and Privacy do not need a router.
export default function App() {
  const path = location.pathname.replace(/\/+$/, "") || "/"
  const page =
    path === "/terms" ? (
      <Legal doc="terms" />
    ) : path === "/privacy" ? (
      <Legal doc="privacy" />
    ) : (
      <Landing />
    )
  return <Suspense fallback={null}>{page}</Suspense>
}
