# Gond Agent

Self-hosted coding agents that turn repository tasks into pull requests. Every account has every feature: all configured models, scheduled runs, GitHub automations and images.

## Run on your server

Requirements: a Linux x86_64 host with a current Docker Engine (25+) and Docker Compose, plus at least 2 GiB RAM and disk space per active run. A normal Linux VM on Proxmox works without nested virtualization. The application runs in Docker and creates one separate non-root worker container per run.

The Compose configuration is [docker-compose.yml](docker-compose.yml); supported deployment settings are documented in [.env.example](.env.example). It uses prebuilt runtime and worker images from GHCR. You do not need to build the source on your server.

```sh
cp .env.example .env
openssl rand -base64 32
# Paste the output into BETTER_AUTH_SECRET in .env; set your browser origin.
chmod 600 .env
docker compose config --quiet
docker compose pull
docker compose up -d
```

Use `docker compose config --quiet` to validate without printing resolved secrets. Keep the auth secret stable across upgrades because it protects sessions and encrypted connections. `PORT` selects the published host port; update `BETTER_AUTH_URL` to match the browser origin. `DOCKER_SOCKET_PATH` selects the existing Docker socket. A missing socket causes a startup error instead of being silently created. The named `gond-agent-data` volume persists SQLite and run data; do not remove it during upgrades.

1. Copy `.env.example` to `.env`. Set `BETTER_AUTH_SECRET` (generate with `openssl rand -base64 32`) and `BETTER_AUTH_URL`. Keep this secret unchanged across restarts.
2. Run `docker compose pull`, then `docker compose up -d`. Both images are pulled. The `worker-image` helper exits successfully without starting an agent; this is expected. The API creates disposable workers from that image when runs start. Open `http://localhost:8787`. Create the first account while bound to loopback; that account becomes the administrator. Complete model setup in the browser. All accounts have all features; additional registration is disabled unless `ALLOW_SIGNUP=true`.
3. Open **Plugins → Connections → Sign in to GitHub**. Copy the one-time code and follow **Continue on GitHub** to approve it. The runtime already includes GitHub CLI; no download, host login or credential-directory mount is required. Use a dedicated GitHub account where appropriate: every instance account shares its repository access.
4. For remote access, put an HTTPS reverse proxy in front, set `BETTER_AUTH_URL` to the public origin, and restart. Forward WebSocket upgrades for `/ws/` and preserve the origin. Enable `TRUST_PROXY=true` only when the proxy overwrites `X-Forwarded-For`; otherwise rate limits use the direct peer address. Set `BIND_ADDRESS` only as needed. Create the first account before exposing the instance.

Open the server root `/` to enter the application at `/agents/`. An empty instance opens administrator account creation, followed by model-provider setup. Existing instances open sign-in or the workspace. The container contains no marketing frontend or same-origin docs. Documentation lives at [gond.io/agent/docs](https://gond.io/agent/docs), maintained separately in `gond-landing`. Health is at `/health`; auth routes are at `/api/auth/`. CI publishes `ghcr.io/dawsja/gond-agent` and `ghcr.io/dawsja/gond-agent-worker`; `main`, version and SHA tags are available after their workflows succeed. Private packages require registry authentication.

### GitHub connection

Only administrators can start or cancel GitHub sign-in. The code is visible only to the initiating signed-in session; it expires after ten minutes. Approve only the code shown in your own workspace. GitHub CLI requests its standard scopes plus workflow access so agents can push workflow changes. Organization SSO or OAuth restrictions may require additional approval on GitHub.

Approved credentials are encrypted in SQLite with `BETTER_AUTH_SECRET`. Temporary private CLI authorization files are removed on completion, cancellation, expiry and startup. GitHub API calls, HTTPS clones and pushes, pull requests and polling use command-scoped credentials; tokens are never returned to browsers, written into repository archives, or forwarded to workers. **Reconnect GitHub** replaces the connection only after approval. To revoke authorization, use GitHub's authorized OAuth app settings. Explicit service-side `GH_TOKEN` or `GH_CONFIG_DIR` credentials remain usable when no browser-managed connection exists; browser-managed credentials take precedence. Default Compose no longer mounts the host's GitHub configuration, so operators using that mount should connect through the app after updating their Compose file.

The account popup at the bottom of the sidebar contains Settings and Sign out; Settings is not a sidebar navigation item. Documentation is not linked from the workspace. Collapsed navigation uses tooltips; hover or focus the logo to expand it.

### Updates

After the initial setup, update both images and recreate the changed services with:

```sh
docker compose pull
docker compose up -d
```

Keep your data volume and `BETTER_AUTH_SECRET`. Do not use `down -v`. Updating the service interrupts active runs; follow-ups resume from their last pushed branch. To pin a release, set the same version tag in both `GOND_AGENT_IMAGE` and `GOND_AGENT_WORKER_IMAGE`. If your `.env` selects `:local` images, change both entries to the GHCR images in `.env.example` to use this pull-only flow.

### Optional source builds

For development or an unpublished change, explicitly add the build override:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml build
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
```

This selects local images for both the service and its workers. The default Compose file has no build configuration.

### Container security and limits

Docker socket access gives the Gond Agent service administrative control of the Docker host. Use a dedicated trusted machine or Linux VM; do not expose the socket over unauthenticated TCP. Worker containers never receive the socket, application data, host bind mounts, GitHub credentials or provider keys. They run as UID 1000 with a read-only root, dropped capabilities, no privilege escalation, a PID limit, and private workspace volumes/networks. `RUN_CPUS` and `RUN_MEMORY_MB` default to 2 and 2048; `MAX_ACTIVE_RUNS` defaults to 5. Workspace disk use is not quota-limited: monitor free disk space.

Containers share the host kernel and are not a boundary for hostile multi-tenant workloads. Their bridge networks allow dependency downloads; host/LAN destinations are not automatically blocked, so apply host firewall/egress policies when needed. Chromium uses the container as its containment boundary and runs without its own sandbox. Keep the host kernel, Docker and worker image updated.

## Authentication and OIDC

Better Auth handles email/password sign-up, password hashing, cookies, sessions, CSRF checks and rate limiting. Passwords need at least 12 characters. Settings lists and revokes active sessions. An administrator can configure an OIDC issuer, client ID and secret in Settings; the page shows the redirect URI to register with the provider. Discovery, PKCE and verified ID tokens are required. Password sign-in remains enabled. OIDC changes require a sign-in within the last ten minutes. Client secrets are encrypted in SQLite and never returned to the browser. Set `ALLOW_SIGNUP=true` to permit new users, including new OIDC users. Account linking by matching emails is disabled.

## Model providers

After the first sign-in, setup connects your model APIs. An administrator can add multiple connections in **Settings → Model providers**: Anthropic Messages, OpenAI-compatible Chat Completions, or OpenAI Responses. Give each connection a name, API base URL including its prefix (for example, `https://api.anthropic.com/v1`, `https://api.openai.com/v1`, or `http://127.0.0.1:8000/v1`) and API key if required. Save the connections to open the workspace; setup does not require selecting or entering models.

When starting an agent, the model picker automatically combines available models from every saved connection, grouped by connection name. Adding another key/URL expands these choices without a separate model-configuration step. Identical model IDs from different connections remain separate options, so the selected connection supplies the correct key. **Refresh models** reloads the catalog. Auto uses the saved instance default when available, otherwise the first available model. New instances do not need to configure a default.

Selecting Anthropic switches the built-in OpenAI URL to `https://api.anthropic.com/v1`; switching back restores the OpenAI default. Explicit custom proxy URLs are preserved. Model discovery uses the provider's `/models` endpoint with the correct authentication and bounded Anthropic pagination. Catalogs are cached briefly per connection; provider failures are shown without hiding other connections' models. Returned names, token limits and image capabilities are used when supplied. For APIs without discovery or for custom capabilities, use **Advanced model overrides** in provider settings. Missing capability information uses conservative defaults; review overrides for your endpoint as needed.

Keys are encrypted in SQLite using the persistent auth secret and never returned to the browser or workers. Blank key updates preserve the saved key; explicitly clear it to remove it. Changing an endpoint URL or API format requires re-entering or clearing its saved key. Local HTTP endpoints are supported; use HTTPS for remote providers. Requests reject redirects. In Compose, `127.0.0.1` refers to the API container: use `http://host.docker.internal:8000/v1` for a host model server, or a reachable service address. The host server must listen on an interface reachable from Docker. Provider settings apply to all accounts. Token usage is recorded locally; currency costs are not estimated for custom providers.

## Runs and GitHub

The worker follows **go deep first**: understand the affected code, choose a design, prove the behavior and review the final changes before completing. `symbols` provides parser-backed file outlines and exact definitions through Universal Ctags, plus explicitly lexical references. `batch` returns ordered results/errors for up to eight independent reads, searches, symbol queries or background-output reads; it cannot execute commands or write files. Persistent agent memory has been removed; repository `AGENTS.md`, `GOND_AGENT.md` and `CLAUDE.md` instructions still apply.

The worker image includes pinned Playwright, Chromium, fonts and browser dependencies. The `browser` tool runs a supplied Playwright test body with `page` and `expect` independently at 1440×900 and 390×844, returning screenshots to the model and transcript alongside console/network failures. Start app servers with background `bash`; custom browser tests can import `@playwright/test` through the worker's `NODE_PATH`. Use an image-capable model to inspect screenshots. Browser execution stays inside the worker container, with no host credentials or host browser access.

Coding turns that write files or execute commands require `finish_review`: understanding/design, successful foreground check call IDs, a final diff inspection and self-review. Recognized web projects (or work declared as a web app) also require a passing `browser` result for both viewports. Checks are tied to a hash of HEAD, the tracked diff and untracked file contents; subsequent changes invalidate earlier evidence. Blocked verification or repeated attempts to finish without review fail the run without publishing changes. This enforces recorded evidence and agent self-review, not the quality of assertions or human approval.

The service uses its saved GitHub connection for repository API calls and HTTPS Git operations. It shallow-clones only the requested branch (`--depth 1 --single-branch --no-tags`), rather than downloading the entire repository history. Full history and other branches are not available inside workers. The run shows download/checkout progress, repository packing, container startup and agent startup separately. Compressed checkout archives are limited to 128 MiB so their base64 controller messages fit safely; an oversized checkout fails with a plain explanation instead of attempting an invalid transfer.

The repository archive enters the run's private workspace volume over Docker's attached stdio. A loopback model relay multiplexes model requests/responses over the same channel, scoped to that run; no model/control ports are published. At turn end, the worker returns a git bundle; the service imports only its objects with hooks disabled and pushes the named run branch. Existing upstream history is preserved. Restarted runs shallow-clone their saved run branch and fetch the original base revision so cumulative diffs still work.

Stop interrupts the current turn. Follow-ups continue in the same container while it is alive. Idle workers and their volumes/networks are destroyed after `RUN_IDLE_MINUTES` (30 by default); a follow-up then starts from the pushed branch. Uncommitted work is lost on shutdown. `RUN_TURN_MINUTES` defaults to 60. A service restart marks interrupted runs failed and removes orphaned Docker resources labeled with this instance's persisted identity, without touching other instances. Run history and diffs persist locally. Merging destroys the workspace. Deleting a run hides it immediately; stored history is purged after 30 days.

Automations supports daily/weekly local-time schedules. The administrator can enable one-minute polling for issues labeled `gond-agent` in `GOND_AGENT_REPOSITORIES`, and retry failing checks on agent pull requests. Occurrence claims prevent duplicate issue/scheduled runs. Check fixes are limited to two consecutive attempts. Model requests go directly to the configured provider. Local usage records have no account limits or feature gates.

## Storage and development

One persistent `/data/gond-agent.sqlite` database (WAL mode) stores accounts, sessions, OIDC/provider settings, schedules, images, transcripts and usage. `/data/checkouts` holds service-side clones; `/data/container-instance` identifies this installation's disposable Docker resources. Worker volumes are temporary and are not application backups. Use a local filesystem volume, not a network filesystem, and run only one service against each data volume. Stop the service before backing up the full data volume, or use SQLite's backup API. Keep backups of the auth secret separately; OIDC and provider secrets depend on it.

API: `cd api && npm ci && BETTER_AUTH_SECRET=<random-32+-characters> npm run dev`. The process uses `BETTER_AUTH_URL=http://localhost:8787` by default. Build `web` for static serving, or run its Vite dev server. Set `BETTER_AUTH_URL` to the browser origin when testing auth through Vite. The workspace dev URL is `/agents/`. HTTP bootstrap works on a private host/LAN address; use HTTPS before exposing accounts or provider keys remotely.

Validation commands and development rules are in [AGENTS.md](AGENTS.md). CI typechecks/tests the API, lints/builds the frontends, checks/tests the worker and builds both Docker targets. Only the workspace frontend enters the runtime image. Docker CI runs real container lifecycle, model relay, Git export, interruption, recovery and browser tests, including first-administrator registration, provider setup and sign-in after a restart at desktop/phone sizes on HTTP. To run the full suite locally after building both images: `cd api && GOND_AGENT_CONTAINER_TEST_IMAGE=gond-agent-worker:local GOND_AGENT_RUNTIME_TEST_IMAGE=gond-agent:local npm test -- test/containers.integration.test.ts`.
