# Gond Agent development guide

Gond Agent is a self-hosted coding workspace. Every account has access to all features. The first registered account administers instance settings; this is an operational permission.

## Layout

- `api/`: Node 24, Hono, Better Auth, local SQLite through better-sqlite3. The process serves both static frontends, handles sessions and OIDC, coordinates runs, and polls GitHub.
- `runner/`: internal Rust worker used inside per-run Docker containers. Its only transport is the JSON event protocol. A loopback model relay multiplexes requests over Docker's attached stdio to the service.
- Worker tools include Universal Ctags symbol navigation, bounded read-only batches and container Playwright browser tests. Persistent agent memory is not supported; keep repository instructions. Coding turns require current verification evidence and self-review through `finish_review`; web apps also require wide/phone browser evidence. Do not describe self-review as human approval.
- `containers/`: non-root worker control service, browser dependencies and image smoke tests. `api/src/containers.ts` owns Docker lifecycle and the scoped model relay.
- `web/`: React workspace, built at `/agents/`; API requests use `/api/` on the same origin.
- `site/`: instance landing page and docs, built at the origin root. Public marketing/docs live in the separate `gond-landing` repository at `https://gond.io/agent`; the public website does not host workspaces.
- `shared/`: frontend code imported through `@shared`.
- `protocol/`: model, agent and live-run event formats.
- `Dockerfile`, `docker-compose.yml`: self-hosted runtime and worker-image targets.

## Work rules

The product is **Gond Agent**, source slug `gond-agent`, contact `hi@gond.io`. Use `GOND_AGENT_*` environment variables, `.gond-agent/` project configuration and `GOND_AGENT.md` product instructions. The static mark is the canonical Gond Bot cloud silhouette in a white circle, without eyes or animation; the other Gond product keeps its cog. `shared/brand.ts`, `shared/brand-mark.ts` and `shared/logo.tsx` define the identity. Keep both frontends' favicon assets aligned. No prior-brand compatibility aliases or migration fallbacks are supported.

Keep changes concise, use the dark-only palette and orange/amber accents, and keep customer messages plain. Use the custom shadcn controls in `shared/ui/`. Keep the canvas #000000, rail #030303, panels #0e0e0e, hover #1a1a1a–#1e1e1e, borders #1c1c1c and input borders #262626. Text is #ededed with #8a8a8a muted text; accents are #e04e0a and #d98a08. Status colors are #a5d6a7, #ffe082, #ef9a9a and #90caf9; destructive actions use #e5484d. Use Inter for UI and JetBrains Mono for code and commands. Do not show internals in ordinary error messages; put technical detail in server logs. Keep secrets out of logs and source.

Database changes use native SQLite statements in `api/src/db.ts`. Additive schema changes must preserve existing data. Better Auth applies its own migrations at startup. OIDC client secrets are encrypted with the persistent auth secret and never returned in API responses. Provider API keys use the same encryption and must never be returned to browsers or workers. Model IDs belong to a configured connection. Only administrators can change providers or OIDC; every account otherwise has all features.

GitHub access uses the service's mounted `gh` login. Never put host credentials, the Docker socket or application data into worker containers. Service Git operations only consume git bundles from workers, with hooks disabled. Workers run as UID 1000 with a read-only root, dropped capabilities, no privilege escalation, resource/PID limits, and private workspace volumes and networks. Docker socket access makes the service trusted; containers share the host kernel and are not hostile multi-tenant isolation. Keep cleanup idempotent, scope it to this instance's persisted Docker labels, and remove orphaned containers/volumes/networks after restarts.

Do not deploy to a user's server, change its data, or publish packages manually unless requested. Source commits go directly to `main`. After checks pass, CI builds and publishes runtime and worker Docker packages on pushes to main and version tags.

## Checks

- `cd api && npm ci && npm run typecheck && npm test`
- `cd web && npm ci && npm run lint && npm run build`
- `cd site && npm ci && npm run lint && npm run build`
- `cd runner && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`
- `python3 -m py_compile containers/agent.py` and `python3 -m unittest discover -s containers -p 'test_*.py'`
- Build `runtime` and `worker-image` Docker targets. Then `cd api && GOND_AGENT_CONTAINER_TEST_IMAGE=gond-agent-worker:local npm test -- test/containers.integration.test.ts` to exercise real Docker lifecycle, streamed model relay, Git export, follow-ups, interruption, cleanup, recovery and browser screenshots. Do not claim container lifecycle verification from mocks alone.
- Worker-image builds run real Chromium interaction/screenshot/error tests and `containers/smoke-worker.py` (real worker tools against a scripted model). Keep `containers/browser/package-lock.json` and the installed browser version in sync.
- Render the landing and workspace at a wide and phone viewport after UI changes. Shared imports resolve from each frontend's dependencies; preserve Vite and TS aliases.

Update this guide, README and protocol when behavior changes.
