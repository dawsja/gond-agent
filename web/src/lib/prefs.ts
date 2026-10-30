// Small UI choices remembered per browser (the composer's repository and model, the sidebar, the run
// page's details panel). Storage can be blocked (private windows): then choices last until reload.

export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`gond-agent.${key}`)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`gond-agent.${key}`, value)
    } catch {
      // not remembered
    }
  },
}
