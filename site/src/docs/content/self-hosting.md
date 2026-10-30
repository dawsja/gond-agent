# Self-hosting

Use a Linux x86_64 host with Docker Engine 25+ and Docker Compose, plus enough disk and memory for each worker container. A Linux VM on Proxmox does not need nested virtualization.

## Prepare the host

Sign in with `gh auth login` on the host. Make the host's GitHub configuration available through the read-only mount in `docker-compose.yml`. If credentials are held in a desktop keyring, use a dedicated file-backed service login with `gh auth login --insecure-storage`.

The service needs access to the Docker socket to create per-run containers, networks and workspace volumes. This grants control of the Docker host: use a dedicated trusted machine or Linux VM. Agent containers never receive the socket or host credentials. Containers share the host kernel; their networks permit outbound access, including reachable host/LAN services. Apply host firewall/egress policy if needed.

## Start Gond Agent

Use `docker-compose.yml` with the documented settings in `.env.example`:

```sh
cp .env.example .env
openssl rand -base64 32
```

Paste the output into `BETTER_AUTH_SECRET` in `.env`, then set `BETTER_AUTH_URL`. Keep the secret unchanged across restarts and upgrades. `BETTER_AUTH_URL` is the browser origin, without `/agents`; match the published `PORT` when connecting directly. Set `DOCKER_SOCKET_PATH` and `GH_CONFIG_PATH` if the defaults do not match your host.

```sh
chmod 600 .env
docker compose config --quiet
docker compose build worker-image gond-agent
docker compose up -d --no-build gond-agent
```

Quiet validation avoids printing resolved secrets. The GitHub directory and Docker socket must already exist; the GitHub configuration is mounted read-only. SQLite and run data persist in the named `gond-agent-data` volume. The worker-image service is only an image build target; the API creates the actual run containers. For published packages, select both runtime and worker images using `GOND_AGENT_IMAGE` and `GOND_AGENT_WORKER_IMAGE` in `.env`, run `docker compose pull gond-agent worker-image`, then `docker compose up -d --no-build gond-agent`. Upgrade both images together, stopping the previous service first.

Bootstrap the first account while bound to loopback, then complete model setup in the browser. Add an Anthropic Messages, OpenAI-compatible Chat Completions or OpenAI Responses connection with its API base URL, optional key and exact model IDs. Choose the default model before opening the workspace. The first account becomes the instance administrator. Additional registration is disabled by default; set `ALLOW_SIGNUP=true` when you want to allow more accounts. Put an HTTPS reverse proxy in front before exposing the instance.

## Model connections

An administrator can manage multiple API connections in Settings → Model providers. Include the API prefix in each base URL, such as `https://api.openai.com/v1`, `https://api.anthropic.com/v1` or a local server's `http://127.0.0.1:8000/v1`. The URL must be reachable from the Gond Agent host. Configure token limits, image support and reasoning for each model. Auto uses the selected default model. Save before testing the connection; the test lists models when the API supports `/models`, and model IDs can always be entered manually.

API keys are encrypted in SQLite and never sent to the browser or workers. Leave a saved key blank to retain it, or explicitly clear it. Re-enter or clear the key when changing its URL or API format. Keep `BETTER_AUTH_SECRET` stable, including when restoring a backup. All accounts use these instance connections; only administrators can edit them. In Compose, use `host.docker.internal` instead of `127.0.0.1` for a provider running on the Docker host, and make that server reachable from Docker.

Voice transcription can use an OpenAI-compatible connection and transcription model via `/audio/transcriptions`. Leave it disabled if your endpoint does not support audio. Model APIs are configured in the browser rather than environment variables. Custom provider costs are not estimated; token usage remains available.

## Authentication

Email and password authentication works immediately. An administrator can add an OIDC issuer, client ID and client secret in Settings. Copy the redirect URI shown there into your identity provider. Use the same persistent auth secret across restarts.

## Data and backups

The data volume contains the SQLite database in WAL mode, service-side checkouts and the container instance identity used for scoped cleanup. Stop the service before copying the volume, or use SQLite's backup API. Per-run Docker volumes are disposable and are removed with their containers. Pushed work stays on GitHub. Do not run multiple services against the same data volume.

## Worker limits and browser testing

Workers run as UID 1000 with a read-only root, dropped capabilities, no privilege escalation, private volumes/networks and a 512-process limit. `MAX_ACTIVE_RUNS` defaults to 5, `RUN_CPUS` to 2 and `RUN_MEMORY_MB` to 2048. `RUN_IDLE_MINUTES` defaults to 30 and `RUN_TURN_MINUTES` to 60. Workspace disk use is not quota-limited. Follow-ups reuse the live worker; idle cleanup or a service restart resumes later from the last pushed branch.

Playwright, Chromium and fonts are built into the worker image. Agents test web apps at wide and phone sizes and return screenshots in the transcript before self-review. Chromium runs without its own sandbox inside the non-root container. Treat this as trusted self-hosted execution, not hostile multi-tenant isolation.

## GitHub automations

Set `GOND_AGENT_REPOSITORIES` to a comma-separated list of repositories that issue automations may watch. The administrator's automation settings enable one-minute polling. All accounts can schedule agents and start repository tasks.
