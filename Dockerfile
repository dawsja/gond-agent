# syntax=docker/dockerfile:1.7
FROM node:24.22.1-bookworm AS frontend
WORKDIR /src
COPY web/package*.json web/
RUN cd web && npm ci
COPY shared/ shared/
COPY web/ web/
RUN cd web && npm run build

FROM rust:1.99.1-bookworm AS worker-build
WORKDIR /src
COPY runner/ ./
RUN cargo build --release --locked

# Reusable tooling for per-run containers. No credentials or host mounts belong in this image.
FROM node:24.22.1-trixie-slim AS worker-tools
RUN apt-get update && apt-get install -y --no-install-recommends bash git ca-certificates curl python3 python3-venv python3-pip build-essential ripgrep universal-ctags jq unzip && rm -rf /var/lib/apt/lists/* && corepack enable
RUN python3 -c "import tarfile; assert hasattr(tarfile, 'data_filter'), 'Python must support safe tar extraction'"
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/gond-agent-browser/browsers NODE_PATH=/opt/gond-agent-browser/node_modules
COPY containers/browser/package*.json /opt/gond-agent-browser/
RUN cd /opt/gond-agent-browser && npm ci && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY containers/browser/browser.cjs /opt/gond-agent-browser/browser.cjs
COPY containers/browser/browser.test.cjs /opt/gond-agent-browser/browser.test.cjs
RUN node --test /opt/gond-agent-browser/browser.test.cjs

FROM worker-tools AS worker-image
COPY --from=worker-build /src/target/release/gond-agent-worker /usr/local/bin/gond-agent-worker
COPY containers/agent.py /opt/gond-agent/agent.py
COPY containers/smoke-worker.py /opt/gond-agent/smoke-worker.py
RUN useradd --uid 1000 --gid 1000 --non-unique --home-dir /home/gond-agent --no-create-home --shell /bin/bash gond-agent \
 && mkdir -p /workspace/repo /home/gond-agent && chown -R 1000:1000 /workspace /home/gond-agent
ENV HOME=/home/gond-agent
USER 1000:1000
RUN python3 /opt/gond-agent/smoke-worker.py
WORKDIR /workspace/repo
ENTRYPOINT ["python3", "-u", "/opt/gond-agent/agent.py"]

FROM node:24.22.1-bookworm AS api-deps
WORKDIR /app/api
COPY api/package*.json ./
RUN npm ci --omit=dev

FROM docker:29.8.0-cli AS docker-cli

FROM node:24.22.1-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git gh ca-certificates tini tar && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app/api
COPY --from=api-deps /app/api/node_modules ./node_modules
COPY api/src/ ./src/
COPY api/package.json ./
COPY --from=frontend /src/web/dist/ /app/web/dist/
ENV NODE_ENV=production GOND_AGENT_DATA_DIR=/data GH_CONFIG_DIR=/gh PORT=8787
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8787')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
