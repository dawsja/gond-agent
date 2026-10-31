# Self-hosting

Use a Linux x86_64 host with Docker Engine 25+ and Docker Compose, plus enough disk and memory for each worker container. A Linux VM on Proxmox does not need nested virtualization.

## Prepare the host

After workspace setup, an administrator connects GitHub in **Plugins → Connections**. Copy the one-time code, open the GitHub approval link and approve the code. GitHub CLI is already installed in the runtime; no host CLI login or credential mount is required. All instance accounts share this connection's repository access. Approved credentials are encrypted on the server and never sent to workers. Codes expire after ten minutes and sign-in can be cancelled.

The service needs access to the Docker socket to create per-run containers, networks and workspace volumes. This grants control of the Docker host: use a dedicated trusted machine or Linux VM. Agent containers never receive the socket or host credentials. Containers share the host kernel; their networks permit outbound access, including reachable host/LAN services. Apply host firewall/egress policy if needed.

## Start Gond Agent

Use `docker-compose.yml` with the documented settings in `.env.example`:

```sh
cp .env.example .env
openssl rand -base64 32
```

Paste the output into `BETTER_AUTH_SECRET` in `.env`, then set `BETTER_AUTH_URL`. Keep the secret unchanged across restarts and upgrades; it also protects saved GitHub credentials. `BETTER_AUTH_URL` is the browser origin, without `/agents`; match the published `PORT` when connecting directly. Set `DOCKER_SOCKET_PATH` if the default does not match your host.

```sh
chmod 600 .env
docker compose config --quiet
docker compose pull
docker compose up -d
```

Quiet validation avoids printing resolved secrets. The GitHub directory and Docker socket must already exist; the GitHub configuration is mounted read-only. SQLite and run data persist in the named `gond-agent-data` volume. Both runtime and worker images default to prebuilt GHCR packages; no source build is required. The `worker-image` helper exits successfully without starting an agent, so normal `docker compose pull` includes its image. The API creates the actual run containers.

For updates, run `docker compose pull` and `docker compose up -d` again. Preserve the data volume and auth secret; do not use `down -v`. Updating interrupts active runs, which can continue later from their last pushed branch. To pin a release, select the same version tag for `GOND_AGENT_IMAGE` and `GOND_AGENT_WORKER_IMAGE`. If your `.env` selects `:local`, replace both entries with the GHCR defaults from `.env.example`.

Source builds are optional: add `-f docker-compose.yml -f docker-compose.build.yml` to both `docker compose build` and `docker compose up -d`. The override selects local runtime and worker images; the default file never builds them.

Bootstrap the first account while bound to loopback, then connect a provider in the browser. Choose OpenAI or Anthropic and add a key if required. URLs are filled in automatically; use Edit URL for custom endpoints. Connection names and OpenAI protocol selection are available under Advanced settings when needed. Save to open the workspace; available models are discovered in the agent model picker. The first account becomes the instance administrator. Additional registration is disabled by default; set `ALLOW_SIGNUP=true` when you want to allow more accounts. Put an HTTPS reverse proxy in front before exposing the instance.

## Model connections

An administrator can manage multiple API connections in Settings → Model providers. Include the API prefix in each base URL, such as `https://api.openai.com/v1`, `https://api.anthropic.com/v1` or a local server's `http://127.0.0.1:8000/v1`. Selecting Anthropic changes the built-in default URL; custom proxy URLs stay intact. The URL must be reachable from the Gond Agent host. Models from all saved keys/URLs appear together when choosing a model for a new agent, grouped by connection. Refresh the picker to reload choices. Auto uses the saved instance default if available, otherwise the first available model.

API keys are encrypted in SQLite and never sent to the browser or workers. Leave a saved key blank to retain it, or explicitly clear it. Re-enter or clear the key when changing its URL or API format. Keep `BETTER_AUTH_SECRET` stable, including when restoring a backup. All accounts use these instance connections; only administrators can edit them. In Compose, use `host.docker.internal` instead of `127.0.0.1` for a provider running on the Docker host, and make that server reachable from Docker.

Model APIs are configured in the browser rather than environment variables. Use **Advanced model overrides** only when listing is unsupported or you need to customize model limits/capabilities. Custom provider costs are not estimated; token usage remains available.

## Authentication

Email and password authentication works immediately. An administrator can add an OIDC issuer, client ID and client secret in Settings. Copy the redirect URI shown there into your identity provider. Use the same persistent auth secret across restarts.

## Data and backups

The data volume contains the SQLite database in WAL mode, service-side checkouts and the container instance identity used for scoped cleanup. Stop the service before copying the volume, or use SQLite's backup API. Per-run Docker volumes are disposable and are removed with their containers. Pushed work stays on GitHub. Do not run multiple services against the same data volume.

## Worker limits and browser testing

Workers run as UID 1000 with a read-only root, dropped capabilities, no privilege escalation, private volumes/networks and a 512-process limit. `MAX_ACTIVE_RUNS` defaults to 5, `RUN_CPUS` to 2 and `RUN_MEMORY_MB` to 2048. `RUN_IDLE_MINUTES` defaults to 30 and `RUN_TURN_MINUTES` to 60. Workspace disk use is not quota-limited. Follow-ups reuse the live worker; idle cleanup or a service restart resumes later from the last pushed branch.

Playwright, Chromium and fonts are built into the worker image. Agents test web apps at wide and phone sizes and return screenshots in the transcript before self-review. Chromium runs without its own sandbox inside the non-root container. Treat this as trusted self-hosted execution, not hostile multi-tenant isolation.

## GitHub automations

All accounts can schedule agents and start repository tasks. GitHub polling, issue-triggered runs and automatic check retries are not supported. Automatic pull-request creation and manual pull-request actions remain available.
