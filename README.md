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

`start_session` accepts optional `title`, `branch` and `pr_body`, also supported by workspace run creation. A title is plain text without newlines, at most 120 characters, and supplies the run, commit and PR titles. A custom branch must match `^(gond-agent|feat|fix|chore|docs)/[a-z0-9][a-z0-9._-]{0,80}(/[a-z0-9._-]{1,80}){0,3}$`, with no `..`, trailing slash or `.lock` suffix; protected names `main`, `master`, `HEAD`, `release*` and `v*` are refused. An existing remote branch is refused unless it belongs to this run.

`pr_body` is plain text up to 20,000 characters. Set it on start or override it with `send_session_message` (or a workspace follow-up); the override persists. An explicit body wins even when empty. Otherwise, the PR uses clean main-agent final text after the last tool call, falling back to the plain run title, never the prompt. Only `end_turn` (the runner's normalized clean stop) qualifies; truncated, refusal/filter and unknown stops do not. Failed/stopped runs and successful turns with no final text use the title. Commentary and subagent text are excluded; the live event transcript stays unchanged.

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
3. Open **Settings → Connections → Connect GitHub**. Copy the one-time code and follow **Continue on GitHub** to approve it. The runtime already includes GitHub CLI; no download, host login or credential-directory mount is required. Each workspace account connects its own GitHub account; its runs use that account’s repository access.
4. For remote access, put an HTTPS reverse proxy in front, set `BETTER_AUTH_URL` to the public origin, and restart. Forward WebSocket upgrades for `/ws/` and preserve the origin. Enable `TRUST_PROXY=true` only when the proxy overwrites `X-Forwarded-For`; otherwise rate limits use the direct peer address. Set `BIND_ADDRESS` only as needed. Create the first account before exposing the instance.

Open the server root `/` to enter the application at `/agents/`. An empty instance opens administrator account creation, followed by model-provider setup. Existing instances open sign-in or the workspace. The container contains no marketing frontend. The public product homepage is [gond.io/agent](https://gond.io/agent), maintained separately in `gond-landing`. Health is at `/health`; auth routes are at `/api/auth/`. CI publishes `ghcr.io/dawsja/gond-agent` and `ghcr.io/dawsja/gond-agent-worker`; `main`, version and SHA tags are available after their workflows succeed. Private packages require registry authentication.

### GitHub connection

Every account can connect, reconnect or disconnect its own GitHub in **Settings → Connections** (also available under Plugins). The login and numeric-ID noreply address of the run owner's effective GitHub connection are used for commits and pull requests. Repository and branch lists use the signed-in account; MCP requests use the personal token owner; schedules use the schedule owner. Without credentials, runs return “Connect your GitHub account in Settings > Connections”.

The device code is visible only to the initiating signed-in session; separate accounts can connect concurrently. Codes expire after ten minutes. Approve only the code shown in your own workspace. GitHub CLI requests its standard scopes plus workflow access. Organization SSO or OAuth restrictions may require additional approval on GitHub.

Approved credentials are encrypted in SQLite with `BETTER_AUTH_SECRET`. Temporary private CLI authorization files are removed on completion, cancellation, expiry and startup. API calls, clones, pushes and PR operations use command-scoped credentials; tokens never reach browsers, repository archives or workers. **Reconnect GitHub** replaces a credential only after approval. **Disconnect** deletes the saved personal token and cancels pending authorization; deleting the local account also deletes its connection. These actions do not revoke GitHub's OAuth grant: use GitHub's **Settings → Applications → Authorized OAuth Apps** to revoke that grant upstream.

Administrators additionally see **Shared connection (used by accounts without their own)** and **Use the shared GitHub connection for accounts without their own**. They can connect/replace/disconnect the shared credential and toggle fallback, but cannot view another account's personal token or repositories. The fallback is **off on new installs without saved shared or service credentials**. On upgrade, an existing shared credential, a non-empty service-side `GH_TOKEN`/`GITHUB_TOKEN`, or `GH_CONFIG_DIR` containing a non-empty `hosts.yml` enables fallback once, preserving existing runs and owners; an administrator's later choice survives restarts. Personal credentials always win. Resolution is personal → shared (only when fallback is enabled) → explicit service-side `GH_TOKEN`, `GITHUB_TOKEN` or `GH_CONFIG_DIR` credentials (also only when fallback is enabled) → a connection error. Turning fallback off prevents every account without a personal connection from using either shared or service credentials. The fallback switch covers both the saved shared connection and service credentials; keep it off for strict account-only access. Default Compose does not mount host GitHub configuration or set an empty `GH_CONFIG_DIR`; configure service credentials explicitly if needed.

### Administrator roles and OIDC linking

The first registered account is an administrator. An administrator can use **Settings → People** to promote or demote accounts, including OIDC accounts. At least one administrator must remain. This changes operational permissions only; it does not merge accounts, run history or personal connections.

To add single sign-on to an existing account, sign in to that account, then within ten minutes choose **Settings → Security → Sign-in methods → Link <provider name>**. Complete the provider's authorization. Better Auth requires the identity provider to supply a verified email or to be configured as a trusted provider; otherwise linking is refused. The verified ID token subject identifies the linked identity; matching email addresses never link accounts implicitly. Unlink is offered only when another sign-in method remains. New OIDC account creation continues to follow `ALLOW_SIGNUP`.

If you already have an administrator password account and a separate non-admin OIDC account, sign in with the password and promote the OIDC account under **People**. Alternatively, use **Link <provider name>** from the administrator account if the identity is not already attached elsewhere. An identity already linked to another account is refused: promote that account, or (if it has another sign-in method) sign in there and unlink first. There is no automatic account merge.

The account popup at the bottom of the sidebar contains Settings and Sign out; Settings is not a sidebar navigation item. The Settings Account card shows your photo, name and email. Sign out stays in the account popup; Settings omits the instance label and storage information block. Collapsed navigation uses tooltips; hover or focus the logo to expand it.

In **Settings → Personal settings → Appearance**, choose **System**, **Light** or **Dark**. System is the default and follows your device live. The preference belongs to your account and follows you to other devices; a local copy only paints the first frame before the server responds. Light uses Gond's linen, paper and carbon palette; Dark preserves Gond Code's existing dark blue palette. The neighboring **Color** control offers blue, purple, pink, red, orange, amber or green in either scheme. The accent is also saved to your account; branding, status colors and neutral avatars stay unchanged. The sidebar shows the logo alone, at the same readable size when expanded or collapsed. In either message composer, **Enter sends** and **Shift+Enter adds a newline**; IME composition does not submit. Your account shows a neutral grey default picture. Pictures from your sign-in provider are never used or loaded; upload your own photo in Settings, Account. In **Settings → Account**, upload a PNG, JPEG or WebP profile photo (up to 2 MiB and 16 megapixels), reposition/zoom it in a circular preview and save. Photos appear in the account menu and your messages, survive restarts, and can be changed or removed. The server re-encodes them as metadata-free, circular 256px PNGs in SQLite. Photos require an authenticated session to view and only their owner can replace or remove them.

In a run's conversation, scrolling up reveals a square down-arrow above the composer. **Scroll to bottom** smoothly returns to the newest content and resumes following updates; reading earlier messages pauses following. The control stays above growing drafts and attachments and respects reduced motion.

Remote images in rendered Markdown output are shown as links (using their alt text or URL) and never loaded automatically. Same-origin images and data/blob image previews still work. An image Content-Security-Policy (`img-src` only) also blocks remote image requests, including tracking pixels and exfiltration beacons; it does not restrict scripts, frames or other resources.

The sidebar uses a compact 28px logo in a 48px header: aligned with navigation icons when expanded, centered when collapsed. **Settings → Delete account** permanently removes your local account, sessions, photos, schedules, runs, images and usage records. Search opens that section, not a deletion action. An extra confirmation asks for your email and current password; passwordless accounts require a sign-in within the last 15 minutes. Stop active runs before deleting. You cannot delete the only administrator while other accounts remain. Deleting the final account also clears saved provider, GitHub and single sign-on connections and returns the server to administrator registration and model setup, even when general registration is closed. Work pushed to GitHub is not deleted.

### Updates

After the initial setup, update both images and recreate the changed services with:

```sh
docker compose pull
docker compose up -d
```

Keep your data volume and `BETTER_AUTH_SECRET`. Do not use `down -v`. Updating the service interrupts active runs; follow-ups resume from their last pushed branch. To pin a release, set the same version tag in both `GOND_AGENT_IMAGE` and `GOND_AGENT_WORKER_IMAGE`.

```sh
GOND_AGENT_IMAGE=ghcr.io/dawsja/gond-agent:0.1.0
GOND_AGENT_WORKER_IMAGE=ghcr.io/dawsja/gond-agent-worker:0.1.0
```

The image tag has no `v` (use `0.1.0`, not `v0.1.0`), and both variables must use the same version.

If your `.env` selects `:local` images, change both entries to the GHCR images in `.env.example` to use this pull-only flow.

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

Installer scratch (`TMPDIR`, `TMP`, `TEMP`, `TEMPDIR`) uses `/opt/gond-tools/tmp`, created in the image with UID 1000 ownership and recreated defensively before the worker starts. Installers can execute temporary binaries there without making `/tmp` or home executable. `XDG_CACHE_HOME=/opt/gond-tools/cache`, `BUN_INSTALL_CACHE_DIR=.../cache/bun`, `npm_config_cache=.../cache/npm`, `PIP_CACHE_DIR=.../cache/pip` and `UV_CACHE_DIR=.../cache/uv` keep caches off the 256 MiB home tmpfs and clean them with the tools volume. `CARGO_TARGET_DIR` is not set: Cargo build outputs remain repo-local.

The image ships Node/npm, Corepack, Python/pip, Bun 1.4.4, uv 0.9.7 and Playwright/Chromium. Bun and uv are pinned linux/amd64 official release assets verified with SHA-256 before installation. Installer variables (`BUN_INSTALL`, `CARGO_HOME`, `RUSTUP_HOME`, `UV_INSTALL_DIR`, `UV_TOOL_DIR`, `UV_PYTHON_INSTALL_DIR`, `UV_TOOL_BIN_DIR`, `XDG_BIN_HOME`, `XDG_DATA_HOME`, `PYTHONUSERBASE`, `npm_config_prefix`, `COREPACK_HOME`, `PNPM_HOME`) point into the tools volume; its bin directories (including `/opt/gond-tools/python/bin` for `pip install --user`) follow the image PATH so downloaded tools cannot shadow image commands such as Git, Python or Bash. uv tool environments and managed Python installations also live in the executable tools volume, not noexec home. Playwright and Node retain their explicit image browser/module paths. The fixed Bun pin supports `bun.lock` lockfileVersion 2; repository `packageManager` fields do not automatically switch Bun versions. Rust is installed per run, for example:

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

Better Auth handles email/password sign-up, password hashing, cookies, sessions, CSRF checks and rate limiting. Passwords need at least 12 characters. Settings lists and revokes active sessions. An administrator can configure an OIDC issuer, client ID and secret in Settings; the page shows the redirect URI to register with the provider. Discovery, PKCE and verified ID tokens are required. Password sign-in remains enabled. OIDC changes require a sign-in within the last ten minutes. Client secrets are encrypted in SQLite and never returned to the browser. Set `ALLOW_SIGNUP=true` to permit new users, including new OIDC users. Account linking by matching emails is disabled. The provider’s `picture` claim is ignored; only locally uploaded account photos are shown.

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

Run transcripts always label messages with the Gond Agent mark and **Agent**, whichever model runs, including retired runs. Model and provider information stays in model pickers, run details, Settings and usage. Transcripts keep agent messages readable and group routine activity into expandable summaries. Open a summary for file names, commands, diffs and output. Failed actions stay visible, and API and ChatGPT plan runs use the same plain activity labels. Runs created by the removed Claude Code and Codex agents keep their transcripts and diffs but can't take follow-ups; start a new run to continue that work.

Linked pull requests refresh while viewing the workspace, including after merging or closing them on GitHub. Merged PRs show a purple merge icon in the run list, header and PR panel. Reads share a short cache; if GitHub is unavailable, the last known state stays visible. Active work can finish before its merged run is closed.

The worker uses a plain workspace prompt; callers supply their own process and verification requirements. `symbols` provides parser-backed file outlines and exact definitions through Universal Ctags, plus explicitly lexical references. `batch` returns ordered results/errors for up to eight independent reads, searches, symbol queries or background-output reads; it cannot execute commands or write files. Persistent agent memory has been removed; repository `AGENTS.md`, `GOND_AGENT.md` and `CLAUDE.md` instructions still apply.

The worker image includes pinned Playwright, Chromium, fonts and browser dependencies. The `browser` tool runs a supplied Playwright test body with `page` and `expect` independently at 1440×900 and 390×844, returning screenshots to the model and transcript alongside console/network failures. Start app servers with background `bash`; custom browser tests can import `@playwright/test` through the worker's `NODE_PATH`. Use an image-capable model to inspect screenshots. Browser execution stays inside the worker container, with no host credentials or host browser access.


The service uses the run owner's effective GitHub connection for repository API calls and HTTPS Git operations. It shallow-clones only the requested branch (`--depth 1 --single-branch --no-tags`), rather than downloading the entire repository history. Full history and other branches are not available inside workers. The run shows download/checkout progress, repository packing, container startup and agent startup separately. Compressed checkout archives are limited to 128 MiB so their base64 controller messages fit safely; an oversized checkout fails with a plain explanation instead of attempting an invalid transfer.

The repository archive enters the run's private workspace volume over Docker's attached stdio. A loopback model relay multiplexes model requests/responses over the same channel, scoped to that run; no model/control ports are published. At turn end, the worker returns a git bundle; the service imports only its objects with hooks disabled and pushes the named run branch. Existing upstream history is preserved. Restarted runs shallow-clone their saved run branch and fetch the original base revision so cumulative diffs still work.

The control service generates a fresh random relay credential for each worker start and passes it in the runner's environment, not its command line. Every relay request requires bearer authentication; requests with an Origin header or an unexpected Host are rejected, and POSTs must use JSON. The API never receives or stores this credential. Shell, checks, browser and MCP subprocesses do not inherit it. This prevents hostile web pages visited by the browser tool from spending the owner's model or search quota; it does not protect against code the agent runs itself. Same-UID code can read the runner's environment through `/proc`. The container remains the boundary, and Docker stdio control trust is unchanged.

For healthy workspaces, Stop only interrupts the current turn; it retains the workspace and uncommitted edits for a follow-up without releasing its slot. For work waiting for capacity, Stop cancels the queued work instead. Stopping a kept failed workspace releases it immediately (see below). Follow-ups continue in the same container while it is alive. Active workspaces have no elapsed-time, idle, step or tool-call budget. Successful idle containers persist until explicitly closed, merged, deleted, service shutdown/recovery, or released before a post-push CI watch; monitor capacity and disk use. The retired `RUN_IDLE_MINUTES` and `RUN_TURN_MINUTES` settings are ignored. Uncommitted work is lost on shutdown. A service restart marks interrupted working runs failed and removes orphaned Docker resources labeled with this instance's persisted identity, without touching other instances; capacity-queued work survives with its queue sequence and pending work. Run history and diffs persist locally. Merging destroys the workspace. Deleting a run hides it immediately; stored history is purged after 30 days.

Automations supports daily/weekly local-time schedules and the automatic pull-request preference. Occurrence claims prevent duplicate scheduled runs. General GitHub issue/check/PR polling and issue-triggered runs remain removed; the only background exception is the bounded post-push CI watcher below. The scheduler never polls GitHub. Existing run history is preserved and obsolete polling preferences are removed on upgrade. Manual pull-request creation/merge remain available; linked PR state otherwise refreshes only on authenticated workspace reads. Model requests go directly to the configured provider. Local usage records have no account limits or feature gates.

### Post-push CI

**Off by default:** the Board decision keeps `GOND_AGENT_CI_FIX_ROUNDS=0` until checkpoint resume is available. Opting in closes/releases the workspace after a pushed turn, before waiting for CI on that revision. The runner's model conversation exists only in process: reopened follow-ups and automatic CI fixes lose earlier model history, even though the saved transcript and pushed branch remain available.

When enabled, the watcher uses the run owner's effective GitHub connection in the service, with no worker running during the wait. Failing checks can trigger an automatic fix follow-up; the transcript labels it **Automatic CI**, not a message from you, and shows a compact CI status line. If optional failed-check log downloads fail, those logs are omitted with a framed notice in the follow-up; check annotations are still used.

The default wait is 20 minutes: poll every 20 seconds for the first two minutes, then every 60 seconds, with at most 120 polls. If no checks appear within two minutes, the result is `none`. `GOND_AGENT_CI_WAIT_MINUTES` sets the wait (1–120, default `20`). `GOND_AGENT_CI_FIX_ROUNDS` sets the durable per-run fix-round limit (0–10, default `0`); `0` disables the watcher. Both settings are passed through Compose from `.env`. An unset fix-round setting is forwarded as an empty string so the API's single default constant owns the fallback. Startup clears `ci_active` for all runs; watches never resume after a service restart.

An automatic fix is admitted as a closed-session follow-up through the persistent workspace queue. If capacity is unavailable or work is already waiting, it queues under the same account fairness, bounds, cancellation and queue-expiry rules as other follow-ups; it does not retry `run_limit`. Accepted work starts automatically when capacity becomes available, without a worker or a CI-deadline retry loop while waiting. A full queue stops the handoff with a queue-specific reason and does not consume a round. Automatic CI fixes start non-interactively, including on runs originally started in the browser or through MCP.

**Protect workflow secrets:** use approval gates or protected environments for any branch-push workflows that expose secrets. Opting into `N` automatic rounds repeats agent code without human review up to that configured limit, including code executed by those workflows.

The watcher respects stops, explicit workspace closes, pending questions and closed or merged pull requests. Automatic pushes that modify CI configuration are refused and need a person. It never merges or performs a review. The local-runner half is deferred to follow-up work.

A follow-up from you is not an automatic CI turn and never authorizes an older CI-configuration change to be pushed. If an automatic publication is refused while your message is waiting, your message stays queued and continues in a clean workspace from the last pushed branch. The unpushed automatic changes are dropped, with a visible needs-person note. Taking over a capacity-reclaimed automatic commit also drops that unpushed commit rather than publishing it implicitly; later follow-ups do not retry it. This is an exception to the kept-work publication recovery described below.

### Waiting for a workspace

`MAX_ACTIVE_RUNS` limits distinct live plus booting workspaces, not just working turns. Ready, idle, stopped and model-failed workspaces still occupy slots while live. Browser/HTTP creates, MCP starts and follow-ups that reopen a closed workspace are validated first, then queued when capacity is unavailable. Accepted work starts automatically: the service drains on release, admission and startup, with a 60-second safety net. You do not need to retry or poll to start it.

Waiting work is FIFO within each account; the account with the fewest occupied workspaces is served first. `queue_position` is 1-based and `queue_length` counts only your account's queued runs. These show relative FIFO order within your account, not a global position or guaranteed start rank. HTTP/MCP get/list/event reads include these additive fields while waiting; live events include `run.queued {position,length}` updates and `run.dequeued`.

Set positive integers in `.env`: `GOND_AGENT_QUEUE_MAX=50` limits total waiting runs, `GOND_AGENT_QUEUE_MAX_PER_ACCOUNT=10` limits waiting runs per account, and `GOND_AGENT_QUEUE_WAIT_HOURS=24` sets maximum waiting time. Compose forwards all three. Full queues return HTTP 429 `queue_full`: "Too many runs are waiting. Try again later." Waiting longer than the configured limit fails with a plain message; this expiry applies only to the queue, never to an active workspace.

Use Stop to cancel waiting work; closing or removing the run also cancels it. Close a retained live workspace to free a slot and automatically start waiting work. Scheduled runs (`source: runner`, also `schedule` supported) never enter or jump the queue and are not subject to its bounds. They fail fast with `run_limit` when capacity is unavailable or the queue is nonempty. Later scheduler ticks may retry, but scheduled runs can be refused for a long time while the queue remains nonempty.

Per-run message request-ID receipt rows grow by one small row per accepted message and remain for the life of the run, even after the message is processed. They prevent duplicate messages on retries and are deleted with the run.

### Commit identity

The service resolves the run owner's effective GitHub connection and caches its login and numeric ID per token. Checkout configuration and every snapshot use that identity for both author and committer: `login <id+login@users.noreply.github.com>`. Missing connection identity fails clearly; global Git identity is not a fallback. Optional `GOND_AGENT_COMMIT_NAME` and `GOND_AGENT_COMMIT_EMAIL` override individual fields (including in Compose). Pull requests use the connected account. Publication adds no attribution, trailers, or product signature; commit/PR titles use the optional title or task, and PR bodies follow the precedence above. Caller/model-provided text is not rewritten.

### Driving Gond Agent from another bot

Use the authenticated remote MCP tools to discover models, start idempotent sessions, wait for completion, inspect diffs, send follow-ups and open PRs. See [the full contract and JSON examples](protocol/README.md#driving-gond-agent-from-another-bot). Completion ends the current turn, not the session: a follow-up starts more work. Browser, symbols and batch tools are optional; repository instructions still apply.

Finished runs retain capacity: use MCP `close_session` or More → Close workspace to save/push changes and release the slot without deleting history, automatically starting waiting work. Busy live workspaces cannot close; closing capacity-queued work cancels it. Snapshot/push failure preserves the workspace. Follow-ups reopen the pushed branch, queuing if needed. `MODEL_STALL_MINUTES` defaults to 10 (0 disables): requests abort only when headers or stream bytes stop arriving, never because a progressing response takes a long time. Missing GitHub identity intentionally fails checkout with a 409 because publication requires the connection. Identity caches expire after one hour and are invalidated on GitHub command failures (including unauthorized responses).

### Transient failures and kept work

GitHub GET requests and network Git clone/fetch/push retry transient network, certificate/TLS, timeout, HTTP 5xx and 429 failures up to five total attempts. GitHub writes (including PR creation, editing and merging) retry only proven pre-send DNS/connection-refused/TLS-handshake or certificate failures, or HTTP 429/503 with an explicit valid Retry-After wait; timeouts and dropped responses are ambiguous and are never replayed. Backoff starts at one second, doubles with full jitter and is capped at 30 seconds; Retry-After can require a longer wait. Foreground GitHub calls share a 60-second total deadline across attempts and waits; only background publication opts into the full schedule. Authentication failures, other HTTP 4xx, rejected/non-fast-forward pushes and unknown errors stop without retrying. Dropped model responses retry the same request up to three total attempts with 1s/2s backoff, only before any tools execute; explicit nonretryable errors stop immediately. A stream-reset event removes a retried attempt's partial text from the transcript and service summary, so the final reply appears once. This also works when a turn compacts context between tool rounds: compaction markers remain visible and summary retries cannot duplicate main-agent text. Main-agent compaction clears the publication reply candidate, so a recovered reply never includes incomplete pre-compaction text; the earlier transcript remains visible. Transient backoff runs at one layer only; context overflow goes directly to the compaction path, not an unchanged-request retry. Summary retries count toward the existing 16-request compaction cap.

Explicit new branches use a create-only lease until their first publication is confirmed: every attempt keeps the same pinned commit and `--force-with-lease=refs/heads/<branch>:` with an empty expectation; later pushes are ordinary non-force pushes. The existing exported `publicationPushOptions(run, beforePush?)` helper in `api/src/runs/publication.ts` composes the lease and optional per-attempt CI guard for the initial import, retained-publication retries and republishing capacity-reclaimed `kept_commit` commits. It sets `lease: "create-only"` only when `run.explicit_branch && !run.pushed` and forwards `beforePush` as `PushOptions.beforePush({cwd,branch,head})`. Explicit branches are supported by workspace/API and MCP requests, and explicitness is persisted rather than inferred from a branch name. `importBundle` keeps retry options as its fifth argument and push options as its sixth.

A stale-info rejection counts as success only if an owner-authenticated remote-ref read equals the exact commit sent, allowing a lost successful response to be reconciled without weakening the lease. A branch created by someone else between attempts is never overwritten, even if a plain push could fast-forward it. A different, missing or unreadable ref remains rejected, with no plain-push fallback. Before every actual push or retry, including retained and reclaimed publication, the CI guard checks the pinned head diff and each intervening commit for CI-configuration changes and rechecks current run/pull-request policy state. The helper's `beforePush` argument runs through the retry scheduler's `beforeAttempt` hook, outside retry classification. A policy refusal propagates unchanged, prevents the push and reports CI `gave_up` with a needs-person reason; it is never retried as a transient failure.

If a turn or publication still fails, its message names the failing step and attempt count. The workspace and service-side clone remain available for **60 minutes**, count toward `MAX_ACTIVE_RUNS`, and expose `work_kept:true`. Send a follow-up during that window: the previous turn's kept snapshot/commit is pushed before new work starts, without re-cloning or losing unpushed changes. Set `GOND_AGENT_FAILED_KEEP_MINUTES` in `.env` to change the grace period; `0` releases immediately. It accepts nonnegative whole minutes within the platform timer range.

When a new run, reopened follow-up or queued work needs capacity, **idle kept failed workspaces can be reclaimed oldest-first** before work waits for a slot. Queued work can reclaim these workspaces too; a kept failure's grace period does not prevent reclamation. The reclaimed workspace's container, private volumes, uncommitted/unimported worker changes and pending bundle are discarded; history and recorded diffs survive. If the worker commit was already imported into the API clone, that clone and commit also survive capacity reclamation: a follow-up first republishes it, then re-creates the workspace from the pushed branch. A failed boot-time republish leaves the saved clone and commit available for another retry. If the branch has never been published, it remains marked unpublished until the push succeeds or its exact commit is reconciled remotely. Snapshot/import failures do not retain large base64 bundles in memory; a follow-up in a still-kept workspace takes a fresh snapshot instead.

**Stopping or closing a still-kept failed workspace releases it immediately and discards unpushed work.** Expiry does the same. Ordinary stop still keeps an otherwise healthy workspace, and successful idle workspaces do not expire. A host/service restart still cleans up disposable workers; absent a saved capacity-reclaimed commit, follow-ups after release/restart use the last pushed branch. The workspace grace period is not a backup across restarts. Deleting a run or account removes its saved API clone as well.

## Storage and development

One persistent `/data/gond-agent.sqlite` database (WAL mode) stores accounts, sessions, OIDC/provider settings, schedules, images, transcripts and usage. `/data/checkouts` holds service-side clones; `/data/container-instance` identifies this installation's disposable Docker resources. Worker volumes are temporary and are not application backups. Use a local filesystem volume, not a network filesystem, and run only one service against each data volume. Stop the service before backing up the full data volume, or use SQLite's backup API. Keep backups of the auth secret separately; OIDC and provider secrets depend on it.

API: `cd api && npm ci && BETTER_AUTH_SECRET=<random-32+-characters> npm run dev`. The process uses `BETTER_AUTH_URL=http://localhost:8787` by default. Build `web` for static serving, or run its Vite dev server. Set `BETTER_AUTH_URL` to the browser origin when testing auth through Vite. The workspace dev URL is `/agents/`. HTTP bootstrap works on a private host/LAN address; use HTTPS before exposing accounts or provider keys remotely.

Validation commands and development rules are in [AGENTS.md](AGENTS.md). CI typechecks/tests the API, lints/builds the workspace frontend, checks/tests the worker and builds both Docker targets. Only the workspace frontend enters the runtime image. Docker CI runs real container lifecycle, model relay, Git export, interruption, recovery and browser tests, including first-administrator registration, provider setup and sign-in after a restart at desktop/phone sizes on HTTP. To run the full suite locally after building both images: `cd api && GOND_AGENT_CONTAINER_TEST_IMAGE=gond-agent-worker:local GOND_AGENT_RUNTIME_TEST_IMAGE=gond-agent:local npm test -- test/containers.integration.test.ts`.

The onboarding fixture clears only persisted auth request budgets between its independent bootstrap and returning phases, while retaining accounts and application settings. Production rate limits still survive restarts; a separate regression test guards that behavior. Browser failures include bounded auth response statuses to distinguish a rejected session lookup from a rendering failure.

### Long conversations

Long conversations compact automatically near the model's context limit, including between tool rounds, and continue without another prompt. At least the last six messages stay unchanged, extending the preserved tail to keep tool calls and results together; older work becomes a summary with the current plan and explicit file paths. Histories of six or fewer messages, or a pair-safe cut of zero, make no summary request; a replacement that is not strictly smaller also reports “Nothing more to compact”. Automatic compaction skips this outcome while used context is still below the window and continues to the model, without trying again until history changes. Manual compaction, overflow recovery and automatic attempts at or above the window still fail plainly; other errors are not skipped. Failures and cancellation preserve the original history, and failed/no-progress attempts do not consume the per-turn compaction count.

For summary input only, old tool output is clipped and old images are replaced with text placeholders before summarization, without decoding or re-encoding. Oversized input is summarized in bounded chunks and merged, with at most 16 summary model requests per compaction including retries. Reaching this cap when further requests are needed fails distinctly with “Too much history to summarise in one pass”. Requests use a conservative serialized-byte bound with output and framing reserves; an unknown context window (`0`) skips the bound check and uses the default 8000-token output reserve. Normal model requests still keep only the eight newest images, independently of compaction; neither image filter changes the stored transcript.

Context overflow triggers one automatic compact-and-retry only when identified by an explicit context-overflow code or HTTP 400 with context-specific wording. HTTP 429, rate-limit codes and generic token or `max_tokens` errors are not context overflow. A turn stops with a plain error when the five-successful-automatic-compaction limit is exhausted or overflow repeats; send a follow-up or choose a larger-window model if the recent context itself is too large. The transcript keeps earlier output and shows a “Context compacted” marker after successful compaction. Task histories receive the same protection.

### Task plans

For multi-step work, the built-in runner can use `update_plan` and `list_plan`. The plan shows as a checklist in the conversation and is also available to other tools over MCP. Run lists show plan counts while work is active.

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

### Workspace tools and optional Web search

The built-in tools include `read`, `write`, `edit`, `multi_edit`, `apply_patch`, `list_directory`, `glob`, `grep`, `symbols`, `batch`, `bash`, `bash_output`, `bash_list`, `kill_shell`, `git`, `run_checks`, `browser` and `web_fetch`, alongside optional MCP tools and the conversation's plan, question, skill and delegation tools. All tools are optional; `run_checks` does not gate completion.

- `grep` streams ordinary files, respects ignore rules and skips binary files. Use `context_before`, `context_after` or `context`, `output_mode: "count"`, and zero-based `offset` with `head_limit` (default/max 300 result lines). Context lines count toward paging. Optional multiline mode accepts files up to 8 MiB; ordinary lines are limited to 1 MiB to bound memory.
- `bash_output` accepts `wait_seconds` (0–120) and an optional `until` regex. Without `until` it returns on new output; with it, it waits for a match, exit or timeout. `bash_list` lists shell IDs, commands and state; `kill_shell` remains available.
- `git` only offers status, diff, log, show and blame, with path/revision/stat filters. The service still owns commits and publication. `run_checks` executes a supplied command, reports exit status/duration, parses common check failures and falls back to an output tail. Background checks use shell IDs.
- Text previews are bounded by a shared output wrapper. Large output is saved under `/tmp/gond-agent-output/` with read/grep instructions. Storage is ephemeral, up to 32 MiB per output and 128 MiB total with oldest-first cleanup; reaching a storage limit is reported, not represented as complete output. A busy store may decline a new spill. Shell output streams to disk before in-memory head/tail buffers discard bytes. Search paging can retrieve more even when a spill is unavailable.
- `read` rejects binary text. All model images (attachments, read, browser and MCP tool results) share a 20 MiB input, 100-megapixel and 128 MiB decode allocation limit. The worker strips metadata, keeps only the first animation frame and re-encodes to at most 1568px on the long side and 1 MiB: JPEG, or PNG only for transparency when smaller. SVG and undecodable images produce plain errors. Processing runs off the async runtime with two concurrent slots and a 10-second deadline. Requests keep only the eight most recent images; older images become short placeholders while the stored transcript remains unchanged. Uploads retain the API's 5 MB size check; browser-side scaling is only a convenience, not the security boundary. Notebook rendering is not included. Exact edits preserve untouched CRLF/newline bytes; patch updates preserve the file's CRLF/LF and final-newline convention. Failed string matches show numbered candidate lines, never apply fuzzy edits.
- Browser-created and MCP sessions can use `ask_user` to emit a pending question. MCP reports `waiting_for_input`; a follow-up or `send_session_message` answers it and the same turn continues. Scheduled runs (`source: runner`) and other unattended/unknown sources are non-interactive: `ask_user` immediately tells the model to proceed with its best judgment and state its assumption, without waiting or holding a slot for input. This is optional, not a requirement to ask questions.

Administrators can enable **Settings → Agent access → Web search** using a **Brave Search API key** (a free tier exists). Enter the key in Settings after deployment, never in chat or the repository. Clear key/Undo takes effect on Save; Test uses saved settings. Keys are encrypted with the instance auth secret and never sent to browsers or workers. Search runs only when called, through the existing worker control relay, with no hosted model-search dependency and no fallback provider or `web_fetch` fallback. The tool is absent from new workspaces unless a provider and key are configured. Existing workspaces retain their advertised tool list; disabling search takes effect immediately on service requests.

Search returns an explicit untrusted-text warning and `{title,url,snippet}` results, default 5/max 10, with a 1000-character query limit, a 15-second provider timeout and a 1 MiB response-read limit. Provider redirects are rejected; auth/quota/rate errors omit provider bodies and keys. Brave is the first provider behind a small service-side interface; SearXNG is not implemented in this pass.

`GOND_AGENT_WEB_SEARCH_LIMIT` caps service-side web search attempts per run (default 30, 0 unlimited). It accepts only unsigned decimal integers through u32; invalid values warn without echoing the value and use 30. Compose exposes the setting in `.env.example`. Attempts, including errors/cancellations, are counted and saved in SQLite before provider work; the count is shared across concurrent calls, follow-ups, worker reopen and service restart. A limit response says "web search limit for this run reached" as a tool error, never a failed run. Settings connection tests are not run calls and do not consume a run's allowance.

Interactive browser/MCP questions wait at most `GOND_AGENT_QUESTION_WAIT_MINUTES` (default 240 minutes / 4 hours; 0 waits indefinitely). This is only a wait-for-a-human/bot timeout, **not a run time budget**: expiry returns "No one answered; decide yourself and continue" and the same run continues. Answers before expiry still resume normally. The service validates unsigned decimal u32 integers (invalid values warn without echoing them and use 240), reads the setting and passes `question_wait_minutes` at worker start; Compose and `.env.example` expose it. A matching `question.resolved {request_id,agent_id}` event clears pending input on answer or timeout, returning MCP state from `waiting_for_input` to `working` before the turn ends. Scheduled runs remain non-interactive and never wait at all.
