# Gond Agent development guide

Gond Agent is a self-hosted coding workspace. Every account has access to all features. The first registered account administers instance settings; this is an operational permission.

## Layout

- `api/`: Node 24, Hono, Better Auth, local SQLite through better-sqlite3. The process serves the workspace, handles sessions and OIDC, coordinates runs, and polls GitHub. `/` redirects to `/agents/`: empty instances show administrator registration, then model setup; configured instances show sign-in or the workspace.
- `runner/`: internal Rust worker used inside per-run Docker containers. Its only transport is the JSON event protocol. A loopback model relay multiplexes requests over Docker's attached stdio to the service.
- Worker tools include Universal Ctags symbol navigation, bounded read-only batches and container Playwright browser tests. Persistent agent memory is not supported; keep repository instructions. Coding turns require current verification evidence and self-review through `finish_review`; web apps also require wide/phone browser evidence. Do not describe self-review as human approval.
- `containers/`: non-root worker control service, browser dependencies and image smoke tests. `api/src/containers.ts` owns Docker lifecycle and the scoped model relay.
- `web/`: React workspace, built at `/agents/`; API requests use `/api/` on the same origin.
- `site/`: standalone site source, not built or served by the self-hosted runtime. Public marketing/docs live in the separate `gond-landing` repository at `https://gond.io/agent`; the public website does not host workspaces. Never bundle a marketing frontend into the application image.
- `shared/`: frontend code imported through `@shared`.
- `protocol/`: model, agent and live-run event formats.
- `Dockerfile`, `docker-compose.yml`: self-hosted runtime and worker-image targets. Default Compose uses prebuilt GHCR images: `docker compose pull && docker compose up -d` updates both. The one-shot `worker-image` helper exits successfully; only the API launches actual workers. Source builds require the explicit `docker-compose.build.yml` override.

## Work rules

The product is **Gond Agent**, source slug `gond-agent`, contact `hi@gond.io`. Use `GOND_AGENT_*` environment variables, `.gond-agent/` project configuration and `GOND_AGENT.md` product instructions. The static mark is the canonical Gond Bot cloud silhouette in a white circle, without eyes or animation; the other Gond product keeps its cog. `shared/brand.ts`, `shared/brand-mark.ts` and `shared/logo.tsx` define the identity. Keep both frontends' favicon assets aligned. No prior-brand compatibility aliases or migration fallbacks are supported.

Keep changes concise, use the dark-only palette and orange/amber accents, and keep customer messages plain. Use the custom shadcn controls in `shared/ui/`. Keep the canvas #000000, rail #030303, panels #0e0e0e, hover #1a1a1a–#1e1e1e, borders #1c1c1c and input borders #262626. Text is #ededed with #8a8a8a muted text; accents are #e04e0a and #d98a08. Status colors are #a5d6a7, #ffe082, #ef9a9a and #90caf9; destructive actions use #e5484d. Use Inter for UI and JetBrains Mono for code and commands. Do not show internals in ordinary error messages; put technical detail in server logs. Keep secrets out of logs and source.

Database changes use native SQLite statements in `api/src/db.ts`. Additive schema changes must preserve existing data. Better Auth applies its own migrations at startup. OIDC client secrets are encrypted with the persistent auth secret and never returned in API responses. Provider API keys use the same encryption and must never be returned to browsers or workers. Model IDs belong to a configured connection. Only administrators can change providers or OIDC; every account otherwise has all features.

GitHub access is an instance-wide connection. Administrators sign in through gh's browser device flow; codes are session-owned, bounded and cancellable. Approved tokens are encrypted with the persistent auth secret. Use command-scoped credentials for GitHub API calls, clones, pushes, pull requests and polling; never mutate global process credentials or Git configuration. Explicit service gh credentials can be used when no managed token exists, but default Compose requires no host login mount. Never put host credentials, the Docker socket or application data into worker containers. Service Git operations only consume git bundles from workers, with hooks disabled. Workers run as UID 1000 with a read-only root, dropped capabilities, no privilege escalation, resource/PID limits, and private workspace volumes and networks. Docker socket access makes the service trusted; containers share the host kernel and are not hostile multi-tenant isolation. Keep cleanup idempotent, scope it to this instance's persisted Docker labels, and remove orphaned containers/volumes/networks after restarts.

Do not deploy to a user's server, change its data, or publish packages manually unless requested. Source commits go directly to `main`. After checks pass, CI builds and publishes runtime and worker Docker packages on pushes to main and version tags.

## Checks

Provider settings manage connections, not a required model catalog. Saving name/format/URL/key must finish setup without choosing models. The agent and schedule model pickers combine live models from all saved connections, with connection-scoped IDs, short per-connection caching and isolated errors. Manual model overrides are an advanced fallback, not a setup step. Never reuse a saved key after URL/format changes without explicit replacement or clearing; never follow discovery redirects or expose keys in catalog responses. Anthropic format changes switch built-in default URLs but preserve custom proxies. Voice recording/transcription is not a supported feature; do not restore its UI, routes or settings.

- `cd api && npm ci && npm run typecheck && npm test`
- `cd web && npm ci && npm run lint && npm run build`
- `cd site && npm ci && npm run lint && npm run build`
- `cd runner && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked`
- `python3 -m py_compile containers/agent.py` and `python3 -m unittest discover -s containers -p 'test_*.py'`
- Build `runtime` and `worker-image` Docker targets as `gond-agent:local` and `gond-agent-worker:local`. Then `cd api && GOND_AGENT_CONTAINER_TEST_IMAGE=gond-agent-worker:local GOND_AGENT_RUNTIME_TEST_IMAGE=gond-agent:local npm test -- test/containers.integration.test.ts` to exercise real Docker lifecycle, streamed model relay, Git export, follow-ups, interruption, cleanup, recovery and browser onboarding. Do not claim container lifecycle verification from mocks alone. CI saves onboarding screenshots as an artifact.
- Worker-image builds run real Chromium interaction/screenshot/error tests and `containers/smoke-worker.py` (real worker tools against a scripted model). Keep `containers/browser/package-lock.json` and the installed browser version in sync.
- Render account creation, provider setup and the workspace at wide and phone viewports after UI changes. Shared imports resolve from each frontend's dependencies; preserve Vite and TS aliases.
- Verify first-account registration → provider setup → workspace with the real packaged API and SQLite at wide/phone sizes on a non-loopback HTTP origin. UI IDs must use `crypto.getRandomValues`, not secure-context-only `crypto.randomUUID`.

Update this guide, README and protocol when behavior changes.
