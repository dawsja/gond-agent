import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { lazy, Suspense } from "react"
import { BrowserRouter, Navigate, Route, Routes } from "react-router"
import { AuthGate } from "@/app/auth"
import { SetupGate } from "@/features/setup/setup-screen"
import { HomeScreen } from "@/features/home/home-screen"
import { ApiError } from "@/lib/api"
import { BASE } from "@/lib/base"

const RunScreen = lazy(() =>
  import("@/features/run/run-screen").then((m) => ({ default: m.RunScreen }))
)
const UsageScreen = lazy(() =>
  import("@/features/usage/usage-screen").then((m) => ({
    default: m.UsageScreen,
  }))
)
const PluginsScreen = lazy(() =>
  import("@/features/plugins/plugins-screen").then((m) => ({
    default: m.PluginsScreen,
  }))
)
const AutomationsScreen = lazy(() =>
  import("@/features/automations/automations-screen").then((m) => ({
    default: m.AutomationsScreen,
  }))
)
const SettingsScreen = lazy(() =>
  import("@/features/settings/settings-screen").then((m) => ({
    default: m.SettingsScreen,
  }))
)

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Don't hammer the API on auth or not-found errors; retry transient ones.
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <SetupGate>
        <BrowserRouter basename={BASE || undefined}>
          <Suspense fallback={<div className="h-screen bg-background" />}>
            <Routes>
              <Route path="/" element={<HomeScreen />} />
              <Route path="/runs/:id" element={<RunScreen />} />
              <Route path="/usage" element={<UsageScreen />} />
              <Route path="/plugins" element={<PluginsScreen />} />
              <Route path="/automations" element={<AutomationsScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        </SetupGate>
      </AuthGate>
    </QueryClientProvider>
  )
}

export default App
