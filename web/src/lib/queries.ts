import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, type GithubStatus, type Me, type ModelCatalog, type Repo, type Run, type Runner } from "./api"

const LIVE: Run["status"][] = ["queued", "working"]

export const useMe = () => useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/v1/me"), staleTime: 30_000, refetchInterval: q => q.state.data?.setup_required ? 5000 : false })

const modelCatalogOptions = { queryKey: ["models"], queryFn: () => api<ModelCatalog>("/v1/models"), staleTime: 60_000 }
export const useModelCatalog = () => useQuery(modelCatalogOptions)
export const useModels = () => useQuery({ ...modelCatalogOptions, select: (catalog: ModelCatalog) => catalog.models })
export function useRefreshModels() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: () => api<ModelCatalog>("/v1/models?refresh=1"), onSuccess: catalog => qc.setQueryData(["models"], catalog) })
}

/** Every run in the workspace (newest first). Polls while any run is still working. */
export const useRuns = () =>
  useQuery({
    queryKey: ["runs"],
    queryFn: () => api<{ runs: Run[] }>("/v1/runs?limit=100").then((r) => r.runs),
    refetchInterval: (q) => (q.state.data?.some((r) => LIVE.includes(r.status)) ? 3_000 : 20_000),
  })

export const useRun = (id: string | undefined) =>
  useQuery({
    queryKey: ["run", id],
    queryFn: () => api<Run>(`/v1/runs/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data && LIVE.includes(q.state.data.status) ? 4_000 : 30_000),
  })

export const useRunDiff = (id: string | undefined, version: number) =>
  useQuery({ queryKey: ["run-diff", id, version], queryFn: () => api<string>(`/v1/runs/${id}/diff`, { text: true }), enabled: !!id })

export const useGithub = () => useQuery({ queryKey: ["github"], queryFn: () => api<GithubStatus>("/v1/github"), staleTime: 60_000 })

export const useRepos = (enabled = true) =>
  useQuery({ queryKey: ["repos"], queryFn: () => api<{ repos: Repo[] }>("/v1/github/repos").then((r) => r.repos), enabled, staleTime: 60_000 })

export const useBranches = (repo: string | null) =>
  useQuery({
    queryKey: ["branches", repo],
    queryFn: () => api<{ branches: string[] }>(`/v1/github/branches?repo=${encodeURIComponent(repo!)}`).then((r) => r.branches),
    enabled: !!repo,
    staleTime: 60_000,
    retry: false,
  })



export function useCreateRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { repo: string; base_branch?: string; model: string; effort?: string; prompt: string; images?: string[] }) =>
      api<Run>("/v1/runs", { body }),
    onSuccess: (run) => {
      qc.setQueryData(["run", run.id], run)
      void qc.invalidateQueries({ queryKey: ["runs"] })
    },
  })
}

function useRunAction<T = void>(path: (id: string, arg: T) => { path: string; method?: string; body?: unknown }) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, arg }: { id: string; arg: T }) => {
      const r = path(id, arg)
      return api<{ ok: true }>(r.path, { method: r.method ?? "POST", body: r.body ?? {} })
    },
    onSettled: (_d, _e, { id }) => {
      void qc.invalidateQueries({ queryKey: ["run", id] })
      void qc.invalidateQueries({ queryKey: ["runs"] })
    },
  })
}

export const useStopRun = () => useRunAction((id) => ({ path: `/v1/runs/${id}/stop` }))
export const useCreatePull = () => useRunAction((id) => ({ path: `/v1/runs/${id}/pull` }))
export const useMergeRun = () => useRunAction((id) => ({ path: `/v1/runs/${id}/merge` }))
export const useDeleteRun = () => useRunAction((id) => ({ path: `/v1/runs/${id}`, method: "DELETE" }))
export const useSendMessage = () =>
  useRunAction<{ text: string; images: string[]; effort?: string; model?: string }>((id, body) => ({ path: `/v1/runs/${id}/messages`, body }))

/** An image attached to one of a run's messages, as an object URL (fetched with the session token). */
export const useRunImage = (runId: string, imageId: string) =>
  useQuery({
    queryKey: ["run-image", runId, imageId],
    queryFn: () => api<Blob>(`/v1/runs/${runId}/images/${imageId}`, { blob: true }).then((b) => URL.createObjectURL(b)),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  })

export const useRunners = () => useQuery({ queryKey: ["runners"], queryFn: () => api<{ runners: Runner[] }>("/v1/runners").then((r) => r.runners) })

export interface RunnerInput {
  name: string
  repo: string
  base_branch?: string
  model_id: string
  effort?: string
  prompt: string
  frequency: "daily" | "weekly"
  weekdays: number[]
  minute: number
  timezone: string
  enabled?: boolean
}

function useRunnerMutation<T>(path: (input: T) => { path: string; method: string; body?: unknown }) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: T) => {
      const r = path(input)
      return api(r.path, { method: r.method, body: r.body })
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ["runners"] }),
  })
}

export const useSaveRunner = () =>
  useRunnerMutation<RunnerInput & { id?: string }>((input) => ({
    path: input.id ? `/v1/runners/${input.id}` : "/v1/runners",
    method: input.id ? "PUT" : "POST",
    body: input,
  }))
export const useSetRunnerEnabled = () =>
  useRunnerMutation<{ id: string; enabled: boolean }>(({ id, enabled }) => ({ path: `/v1/runners/${id}/enabled`, method: "PUT", body: { enabled } }))
export const useDeleteRunner = () => useRunnerMutation<string>((id) => ({ path: `/v1/runners/${id}`, method: "DELETE" }))
