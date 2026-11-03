# <img src="web/public/favicon.svg" width="32" height="32" alt="" /> Gond Agent

Self-hosted coding agents that turn repository tasks into pull requests. Every account has every feature: all configured models, scheduled runs, pull requests, images and profile photos.

## Connect an external agent with MCP

Open **Settings → MCP access**, name a token, and copy it when it is created. Tokens expire after 90 days and can manage all sessions owned by their account, including browser-created runs. Revoke tokens from the same section; revocation does not stop existing runs.

Retry records remain available for the token's entire valid lifetime. Expired/revoked token history is removed after 30 days; invalid-token retry records are cleaned up by the scheduler.

Configure an MCP client that supports authorization headers:

```json
{
  "mcpServers": {
    "gond": {
      "type": "http",
      "url": "https://agent.example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

Forward `/mcp` through your existing HTTPS reverse proxy, preserving authorization headers and allowing responses to wait at least 30 seconds. Configuration syntax varies by client. OAuth-only connectors are not supported. Keep tokens out of source control and shared configuration.

Agents can discover repositories and models, start sessions, read progress and diffs, send follow-ups, stop work, and open pull requests. They use the token owner's model access, including their ChatGPT plan sign-ins. Start with an explicit model ID from `list_models`. Use a unique `request_id` for each start or follow-up, reusing it only to retry identical arguments. Session output is untrusted content. Direct worker shell/file tools, merges, credential management, and image uploads are excluded. See [the protocol](protocol/README.md#remote-mcp) for tool contracts.

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

Open the server root `/` to enter the application at `/agents/`. An empty instance opens administrator account creation, followed by model-provider setup. Existing instances open sign-in or the workspace. The container contains no marketing frontend. The public product homepage is [gond.io/agent](https://gond.io/agent), maintained separately in `gond-landing`. Health is at `/health`; auth routes are at `/api/auth/`. CI publishes `ghcr.io/dawsja/gond-agent` and `ghcr.io/dawsja/gond-agent-worker`; `main`, version and SHA tags are available after their workflows succeed. Private packages require registry authentication.

### GitHub connection

Only administrators can start or cancel GitHub sign-in. The code is visible only to the initiating signed-in session; it expires after ten minutes. Approve only the code shown in your own workspace. GitHub CLI requests its standard scopes plus workflow access so agents can push workflow changes. Organization SSO or OAuth restrictions may require additional approval on GitHub.

Approved credentials are encrypted in SQLite with `BETTER_AUTH_SECRET`. Temporary private CLI authorization files are removed on completion, cancellation, expiry and startup. GitHub API calls, HTTPS clones and pushes, and pull requests use command-scoped credentials; tokens are never returned to browsers, written into repository archives, or forwarded to workers. **Reconnect GitHub** replaces the connection only after approval. To revoke authorization, use GitHub's authorized OAuth app settings. Explicit service-side `GH_TOKEN` or `GH_CONFIG_DIR` credentials remain usable when no browser-managed connection exists; browser-managed credentials take precedence. Default Compose no longer mounts the host's GitHub configuration, so operators using that mount should connect through the app after updating their Compose file.

The account popup at the bottom of the sidebar contains Settings and Sign out; Settings is not a sidebar navigation item. The Settings Account card shows your photo, name and email. Sign out stays in the account popup; Settings omits the instance label and storage information block. Collapsed navigation uses tooltips; hover or focus the logo to expand it.

The workspace uses Gond Code's default dark blue palette. The sidebar shows the logo alone, at the same readable size when expanded or collapsed. In either message composer, **Enter sends** and **Shift+Enter adds a newline**; IME composition does not submit. In **Settings → Account**, upload a PNG, JPEG or WebP profile photo (up to 2 MiB and 16 megapixels), reposition/zoom it in a circular preview and save. Photos appear in the account menu and your messages, survive restarts, and can be changed or removed. The server re-encodes them as metadata-free, circular 256px PNGs in SQLite. Photos require an authenticated session to view and only their owner can replace or remove them.

The sidebar uses a compact 28px logo in a 48px header: aligned with navigation icons when expanded, centered when collapsed. **Settings → Delete account** permanently removes your local account, sessions, photos, schedules, runs, images and usage records. Search opens that section, not a deletion action. An extra confirmation asks for your email and current password; passwordless accounts require a sign-in within the last 15 minutes. Stop active runs before deleting. You cannot delete the only administrator while other accounts remain. Deleting the final account also clears saved provider, GitHub and single sign-on connections and returns the server to administrator registration and model setup, even when general registration is closed. Work pushed to GitHub is not deleted.

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

Workers keep `/tmp` (1 GiB) and `$HOME` (256 MiB) on `nosuid,nodev,noexec` tmpfs. Install executable toolchains in `/opt/gond-tools`, a second writable, executable named volume owned by UID 1000 outside the Git checkout. Each run has its own tools volume, with the same instance/run labels and cleanup as the workspace: close, destroy, failed startup and restart recovery remove it. Follow-ups in a live run retain it; reopening a closed run starts fresh. Nothing is shared across runs or users: a shared executable cache could let one run poison another. Workspace **and tools** disk use is not quota-limited; monitor Docker host storage, especially for Rust installations.

The image ships Node/npm, Corepack, Python/pip, Bun 1.3.2, uv 0.9.7 and Playwright/Chromium. Bun and uv are pinned linux/amd64 official release assets verified with SHA-256 before installation. Installer variables (`BUN_INSTALL`, `CARGO_HOME`, `RUSTUP_HOME`, `UV_INSTALL_DIR`, `XDG_BIN_HOME`, `npm_config_prefix`, `COREPACK_HOME`, `PNPM_HOME`) point into the tools volume; its bin directories precede the image PATH. Rust is installed per run, for example:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal -c rustfmt -c clippy
cargo --version
```

Noexec scratch is defense in depth against dropped binaries, not the isolation boundary: Python, Node and Bash already execute arbitrary code as UID 1000, including syscalls through FFI. The boundary remains the container: dropped capabilities, no-new-privileges, default seccomp, read-only root, private volumes/network, and no host mounts, Docker socket or credentials. Executing downloaded/compiled native code exposes more of the kernel's seccomp-filtered syscall surface. Docker's ordinary disk-backed named-volume interface does not offer per-mount `nosuid,nodev`; these flags remain enforced on scratch tmpfs, not claimed for the tools volume. Dropped capabilities and no-new-privileges still prevent privilege gains via devices or setuid binaries. The existing checkout volume is also executable; do not install toolchains there because they would pollute snapshots.

To bake Rust or other large dependencies into an operator-controlled custom image, extend the worker image (not the runtime), install into the read-only image's `/usr/local` rather than the per-run volume, and restore UID 1000:

```dockerfile
FROM ghcr.io/dawsja/gond-agent-worker:main
USER root
# Install pinned project-specific dependencies into /usr/local here.
USER 1000:1000
```

Build it with `docker build --platform linux/amd64 -t gond-agent-worker:custom -f Dockerfile.worker .`, set `GOND_AGENT_WORKER_IMAGE=gond-agent-worker:custom` in `.env`, and run `docker compose up -d --pull never`. Both the helper and service select that image; it must exist on the service's Docker host. Per-repository setup settings and shared toolchain caches are not supported.

Containers share the host kernel and are not a boundary for hostile multi-tenant workloads. Their bridge networks allow dependency downloads; host/LAN destinations are not automatically blocked, so apply host firewall/egress policies when needed. Chromium uses the container as its containment boundary and runs without its own sandbox. Keep the host kernel, Docker and worker image updated.

## Authentication and OIDC

Settings are grouped under large headings for Personal settings, Models, Security, Agent access and Account management. Administrator-only provider and single sign-on controls remain in their respective groups.

Better Auth handles email/password sign-up, password hashing, cookies, sessions, CSRF checks and rate limiting. Passwords need at least 12 characters. Settings lists and revokes active sessions. An administrator can configure an OIDC issuer, client ID and secret in Settings; the page shows the redirect URI to register with the provider. Discovery, PKCE and verified ID tokens are required. Password sign-in remains enabled. OIDC changes require a sign-in within the last ten minutes. Client secrets are encrypted in SQLite and never returned to the browser. Set `ALLOW_SIGNUP=true` to permit new users, including new OIDC users. Account linking by matching emails is disabled.

## Model providers

Every run uses Gond Agent's built-in runner. Models come from two places: API connections an administrator saves for everyone, and ChatGPT plans that each account signs in to for itself (see [ChatGPT plan](#chatgpt-plan)). Model pickers show versioned names from provider catalogs, without a hardcoded version list. Hover a model to see its exact reported ID, or search by that ID.

A ChatGPT sign-in works without an API provider. To remove unused API connections, open **Settings → Model providers → Advanced settings → Remove provider**, then **Save changes**. You can remove the final API connection. Connection warnings appear only for the selected connection, or when no models are available.

New tasks and follow-ups place image attachments first, then the model and thinking effort selectors. Model and thinking menus share the same style and control height and show each model's brand mark. Follow-ups can switch to any available model, including between API connections and a ChatGPT plan.

After the first sign-in, setup offers **Continue with ChatGPT** and a ready-to-edit API connection. An administrator can add more connections in **Settings → Model providers**, directly below **ChatGPT plan**. Choose **OpenAI** (including compatible APIs) or **Anthropic**, add a key if required, then save. Provider URLs are filled in automatically; **Edit URL** allows a custom API base URL including its prefix, such as `http://127.0.0.1:8000/v1`. Setup does not require selecting or entering models. Connection names are optional overrides under **Advanced settings**. OpenAI connections default to Chat Completions; select Responses there if your provider requires it. Saved protocol choices are preserved.

When starting an agent, the model picker automatically combines available models from every saved connection, grouped by connection name. Adding another key/URL expands these choices without a separate model-configuration step. Identical model IDs from different connections remain separate options, so the selected connection supplies the correct key. **Refresh models** reloads the catalog. Auto uses the saved instance default when available, otherwise the first available model. New instances do not need to configure a default.

Supported API formats are OpenAI Responses, OpenAI Chat Completions and Anthropic Messages. Any OpenAI-compatible endpoint works with the OpenAI button, including xAI (`https://api.x.ai/v1`, Responses or Chat Completions) and proxies such as LiteLLM, OpenRouter, vLLM or Ollama. Each format supports model discovery, streamed text and tool calls, images where the model accepts them, token and cache usage, and plain error messages. Thinking effort is sent the way each provider expects: Responses `reasoning.effort` (xAI without reasoning summaries), Chat Completions `reasoning_effort`, and Anthropic adaptive effort or a thinking budget. Grok accepts an effort only on its mini reasoning models; other Grok models reason without one. Official OpenAI and xAI catalogs hide embedding, audio, image-generation and moderation models that can't run the agent.

Selecting Anthropic switches the built-in OpenAI URL to `https://api.anthropic.com/v1`; switching back restores the OpenAI default. Explicit custom proxy URLs are preserved. Model discovery uses the provider's `/models` endpoint with the correct authentication and bounded Anthropic pagination. Catalogs are cached briefly per connection; provider failures are shown without hiding other connections' models. Returned names, token limits and image capabilities are used when supplied. For APIs without discovery or for custom capabilities, add manual model overrides under **Advanced settings** in provider settings. Missing capability information uses conservative defaults; review overrides for your endpoint as needed.

Keys are encrypted in SQLite using the persistent auth secret and never returned to the browser or workers. Blank key updates preserve the saved key. **Clear key** marks it for removal when you save; **Undo** restores it before saving. Entering a replacement key cancels pending removal. Changing an endpoint URL or API format requires re-entering or clearing its saved key. Local HTTP endpoints are supported; use HTTPS for remote providers. Requests reject redirects. In Compose, `127.0.0.1` refers to the API container: use `http://host.docker.internal:8000/v1` for a host model server, or a reachable service address. The host server must listen on an interface reachable from Docker. Provider settings apply to all accounts. Token usage is recorded locally; currency costs are not estimated for custom providers.

## Runs and GitHub

Run transcripts keep agent messages readable and group routine activity into expandable summaries. Open a summary for file names, commands, diffs and output. Failed actions stay visible, and API and ChatGPT plan runs use the same plain activity labels. Runs created by the removed Claude Code and Codex agents keep their transcripts and diffs but can't take follow-ups; start a new run to continue that work.

Linked pull requests refresh while viewing the workspace, including after merging or closing them on GitHub. Merged PRs show a purple merge icon in the run list, header and PR panel. Reads share a short cache; if GitHub is unavailable, the last known state stays visible. Active work can finish before its merged run is closed.

The worker uses a plain workspace prompt; callers supply their own process and verification requirements. `symbols` provides parser-backed file outlines and exact definitions through Universal Ctags, plus explicitly lexical references. `batch` returns ordered results/errors for up to eight independent reads, searches, symbol queries or background-output reads; it cannot execute commands or write files. Persistent agent memory has been removed; repository `AGENTS.md`, `GOND_AGENT.md` and `CLAUDE.md` instructions still apply.

The worker image includes pinned Playwright, Chromium, fonts and browser dependencies. The `browser` tool runs a supplied Playwright test body with `page` and `expect` independently at 1440×900 and 390×844, returning screenshots to the model and transcript alongside console/network failures. Start app servers with background `bash`; custom browser tests can import `@playwright/test` through the worker's `NODE_PATH`. Use an image-capable model to inspect screenshots. Browser execution stays inside the worker container, with no host credentials or host browser access.


The service uses its saved GitHub connection for repository API calls and HTTPS Git operations. It shallow-clones only the requested branch (`--depth 1 --single-branch --no-tags`), rather than downloading the entire repository history. Full history and other branches are not available inside workers. The run shows download/checkout progress, repository packing, container startup and agent startup separately. Compressed checkout archives are limited to 128 MiB so their base64 controller messages fit safely; an oversized checkout fails with a plain explanation instead of attempting an invalid transfer.

The repository archive enters the run's private workspace volume over Docker's attached stdio. A loopback model relay multiplexes model requests/responses over the same channel, scoped to that run; no model/control ports are published. At turn end, the worker returns a git bundle; the service imports only its objects with hooks disabled and pushes the named run branch. Existing upstream history is preserved. Restarted runs shallow-clone their saved run branch and fetch the original base revision so cumulative diffs still work.

Stop only interrupts the current turn; it retains the workspace and uncommitted edits for a follow-up. Follow-ups continue in the same container while it is alive. Runs have no elapsed-time, idle, step or tool-call budget. Idle containers persist until explicitly closed, merged, deleted, or service shutdown/recovery; monitor capacity and disk use. The retired `RUN_IDLE_MINUTES` and `RUN_TURN_MINUTES` settings are ignored. Uncommitted work is lost on shutdown. A service restart marks interrupted runs failed and removes orphaned Docker resources labeled with this instance's persisted identity, without touching other instances. Run history and diffs persist locally. Merging destroys the workspace. Deleting a run hides it immediately; stored history is purged after 30 days.

Automations supports daily/weekly local-time schedules and the automatic pull-request preference. Occurrence claims prevent duplicate scheduled runs. GitHub issue/check/PR polling, issue-triggered runs and automatic check retries have been removed; there is no repository-watch environment variable. Existing run history is preserved and obsolete polling preferences are removed on upgrade. Manual pull-request creation/merge remain available; PR changes made outside Gond Agent are no longer synchronized in the background. Model requests go directly to the configured provider. Local usage records have no account limits or feature gates.

### Commit identity

The service resolves and caches the connected GitHub account's login and numeric ID. Checkout configuration and every snapshot use that identity for both author and committer: `login <id+login@users.noreply.github.com>`. Missing connection identity fails clearly; global Git identity is not a fallback. Optional `GOND_AGENT_COMMIT_NAME` and `GOND_AGENT_COMMIT_EMAIL` override individual fields (including in Compose). Pull requests use the connected account. Publication adds no attribution, trailers, or product signature; commit/PR titles come from the task and PR bodies from the final response (or task). Caller/model-provided text is not rewritten.

### Driving Gond Agent from another bot

Use the authenticated remote MCP tools to discover models, start idempotent sessions, wait for completion, inspect diffs, send follow-ups and open PRs. See [the full contract and JSON examples](protocol/README.md#driving-gond-agent-from-another-bot). Completion ends the current turn, not the session: a follow-up starts more work. Browser, symbols and batch tools are optional; repository instructions still apply.

Finished runs retain capacity: use MCP `close_session` or More → Close workspace to save/push changes and release the slot without deleting history. Busy workspaces cannot close; snapshot/push failure preserves the workspace. Follow-ups reopen the pushed branch. `MODEL_STALL_MINUTES` defaults to 10 (0 disables): requests abort only when headers or stream bytes stop arriving, never because a progressing response takes a long time. Missing GitHub identity intentionally fails checkout with a 409 because publication requires the connection. Identity caches expire after one hour and are invalidated on GitHub command failures (including unauthorized responses).

## Storage and development

One persistent `/data/gond-agent.sqlite` database (WAL mode) stores accounts, sessions, OIDC/provider settings, schedules, images, transcripts and usage. `/data/checkouts` holds service-side clones; `/data/container-instance` identifies this installation's disposable Docker resources. Worker volumes are temporary and are not application backups. Use a local filesystem volume, not a network filesystem, and run only one service against each data volume. Stop the service before backing up the full data volume, or use SQLite's backup API. Keep backups of the auth secret separately; OIDC and provider secrets depend on it.

API: `cd api && npm ci && BETTER_AUTH_SECRET=<random-32+-characters> npm run dev`. The process uses `BETTER_AUTH_URL=http://localhost:8787` by default. Build `web` for static serving, or run its Vite dev server. Set `BETTER_AUTH_URL` to the browser origin when testing auth through Vite. The workspace dev URL is `/agents/`. HTTP bootstrap works on a private host/LAN address; use HTTPS before exposing accounts or provider keys remotely.

Validation commands and development rules are in [AGENTS.md](AGENTS.md). CI typechecks/tests the API, lints/builds the workspace frontend, checks/tests the worker and builds both Docker targets. Only the workspace frontend enters the runtime image. Docker CI runs real container lifecycle, model relay, Git export, interruption, recovery and browser tests, including first-administrator registration, provider setup and sign-in after a restart at desktop/phone sizes on HTTP. To run the full suite locally after building both images: `cd api && GOND_AGENT_CONTAINER_TEST_IMAGE=gond-agent-worker:local GOND_AGENT_RUNTIME_TEST_IMAGE=gond-agent:local npm test -- test/containers.integration.test.ts`.

### Task plans

For multi-step work, the built-in runner can use `update_plan` and `list_plan`. A pinned **Tasks** panel shows progress, highlights the current step and updates live without scrolling back through the transcript. On phones it is a compact expandable bar. No panel appears until a plan exists. Run lists show plan counts while work is active.

Plans stay in memory across follow-ups and compaction. The service stores `todos` events and the latest plan summary in SQLite, then restores the plan into a replacement worker when reopening a workspace or continuing after a service restart. This restores plan state, not the full model conversation or unpushed files lost with a removed container.

`GOND_AGENT_PLAN_REMINDER_EVERY` controls context reminders in main-worker model rounds (default `6`, `0` disables). The current bounded plan is included on the next request after a change and at the interval. `GOND_AGENT_PLAN_NUDGE_LIMIT` controls optional continuation nudges when a final response leaves pending/in-progress steps (default `2`, `0` disables, hard maximum `2` per user turn). After that cap, a final response ends normally regardless of plan status. Plans are guidance, never a completion requirement or run failure condition. Set these variables in `.env` for the default Compose deployment (see `.env.example`); the API service validates and forwards them at worker startup. Invalid non-integer, negative or out-of-range settings log a warning without the supplied value and use defaults. A malformed initial plan also logs a warning and starts with an empty plan.

Remote MCP `get_session`, `list_sessions` and `read_session_events` include bounded `plan_steps`, `plan_done`, `plan_total` and `current_step`; see the [protocol](protocol/README.md#task-plan-state).

### ChatGPT plan

Each account can sign in with ChatGPT in **Settings → Models → ChatGPT plan** so the built-in agent uses that person's ChatGPT plan instead of an API key. This uses OpenAI's "Sign in with ChatGPT" token sharing for open-source apps: Gond Agent registers itself on the first sign-in as "Gond Agent", and the issued app registration is kept for that account. Plan usage counts toward the person's ChatGPT limits; review it at [ChatGPT settings → Usage](https://chatgpt.com/settings/usage). Gond Agent never switches a plan request to API billing.

Because the sign-in returns to `http://127.0.0.1:1455/auth/callback` on the computer running the browser, not on the Gond server, sign-in works by pasting back:

1. Select **Continue with ChatGPT**. A ChatGPT tab opens.
2. Approve Gond Agent. The browser then shows a page that can't load, starting with `http://127.0.0.1:1455/auth/callback`.
3. Copy that whole address from the address bar and paste it into Gond Agent, then select **Finish sign-in**.

Gond Agent only reads the pasted address and never opens it. A sign-in attempt belongs to the browser session that started it and expires after 10 minutes. The first successful sign-in shows "You're using your ChatGPT plan". A person can connect several ChatGPT accounts; each appears as its own group in the model picker, with "Using ChatGPT plan" and a **Manage usage** link next to the picker.

Tokens are encrypted in SQLite with `BETTER_AUTH_SECRET`, stay in the API service, and are refreshed there before they expire (or once after a rejected request); refresh tokens rotate and are replaced together with the access token. Workers, browsers and logs never receive them. **Sign out** revokes the session with OpenAI and clears the tokens but keeps the registration for the next sign-in; **Remove** also deletes the account entry. Deleting a Gond account signs out its ChatGPT accounts.

Plan usage is a preview with limits that Gond Agent follows: requests are not stored by OpenAI, the agent's tools are sent in a namespace, and hosted tools, sampling settings and output limits are not used. When a usage limit is reached, the composer and settings show a usage-limit card and Gond Agent pauses plan requests for that account briefly instead of retrying. If ChatGPT reports that plan usage isn't available for an account, workspace or region, Gond Agent says so and stops; it doesn't loop through sign-in again. Use an API connection in those cases.

Grok and other subscriptions are not supported. Use xAI through an API key on an OpenAI-compatible connection.

### Upgrading from Claude Code and Codex agents

Earlier releases could run Claude Code or Codex inside workspaces. These agents and their runtime installation have been removed; Gond Agent now has one backend, the built-in runner. The first start after upgrading deletes saved Claude Code and Codex sign-ins and session state (overwriting them in the database), removes their runtime records, pauses schedules that used their models, and keeps their runs readable. It then removes the pinned runtime volumes that Docker reports with this instance's labels, and orphaned workers of this instance as usual; other instances' resources are never touched. The service log lists what was removed, without secrets.

## License

MIT. See [LICENSE](LICENSE).
