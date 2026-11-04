// Deterministic 65-run history shared by API and browser regression fixtures.
exports.history = (owner = 'fixture') => Array.from({ length: 65 }, (_, i) => ({
  id: `history-${String(i).padStart(3, '0')}`, user_id: owner,
  repo: i % 2 ? 'acme/web' : 'acme/app', base_branch: 'main', branch: `feat/history-${i}`,
  model_id: 'fixture:coder', title: `History task ${i}`, prompt: 'Review the change',
  status: ['working', 'queued', 'ready', 'merged', 'stopped'][i % 5],
  created_at: 1700000000000 + Math.floor(i / 3), updated_at: 1700000000000,
  started_at: null, finished_at: null, pr_number: null, pr_url: null, pr_state: null,
  base_sha: null, head_sha: null,
  // Large counts exercise compact DiffTile and mobile DiffCounts on every page.
  files: 77, additions: 11456, deletions: 99999, step: null, plan_done: 0, plan_total: 0,
  source: 'web', phase: 'idle', pending: [], summary: { plan_steps: [] }, diff: '',
})).sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));
