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
RUN test "$(dpkg --print-architecture)" = amd64 \
 && curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.3.2/bun-linux-x64.zip -o /tmp/bun.zip \
 && echo "0cb56a4484bd7764a3eef9b9e67ab457840981287b46794974d1e6612cbf6709  /tmp/bun.zip" | sha256sum -c - \
 && unzip -q /tmp/bun.zip -d /tmp/bun \
 && install -m 0755 /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
 && curl -fsSL https://github.com/astral-sh/uv/releases/download/0.9.7/uv-x86_64-unknown-linux-gnu.tar.gz -o /tmp/uv.tar.gz \
 && echo "b26fcc8dfa1c39b5a5613445af3be3eefda45d9a39359bee271eafe34913583e  /tmp/uv.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/uv.tar.gz -C /tmp \
 && install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /tmp/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/ \
 && rm -rf /tmp/bun.zip /tmp/bun /tmp/uv.tar.gz /tmp/uv-x86_64-unknown-linux-gnu
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
 && mkdir -p /workspace/repo /home/gond-agent /opt/gond-tools/bin && chown -R 1000:1000 /workspace /home/gond-agent /opt/gond-tools
ENV HOME=/home/gond-agent \
    BUN_INSTALL=/opt/gond-tools/bun \
    CARGO_HOME=/opt/gond-tools/cargo \
    RUSTUP_HOME=/opt/gond-tools/rustup \
    UV_INSTALL_DIR=/opt/gond-tools/bin \
    UV_TOOL_DIR=/opt/gond-tools/uv/tools \
    UV_PYTHON_INSTALL_DIR=/opt/gond-tools/uv/python \
    UV_TOOL_BIN_DIR=/opt/gond-tools/bin \
    XDG_DATA_HOME=/opt/gond-tools/share \
    PYTHONUSERBASE=/opt/gond-tools/python \
    XDG_BIN_HOME=/opt/gond-tools/bin \
    npm_config_prefix=/opt/gond-tools/npm \
    COREPACK_HOME=/opt/gond-tools/corepack \
    PNPM_HOME=/opt/gond-tools/pnpm
ENV PATH="${PATH}:/opt/gond-tools/bin:/opt/gond-tools/bun/bin:/opt/gond-tools/cargo/bin:/opt/gond-tools/npm/bin:/opt/gond-tools/pnpm:/opt/gond-tools/python/bin"
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
COPY shared/model-names.ts shared/profile-photo.ts /app/shared/
COPY api/package.json ./
COPY --from=frontend /src/web/dist/ /app/web/dist/
ENV NODE_ENV=production GOND_AGENT_DATA_DIR=/data GH_CONFIG_DIR=/gh PORT=8787
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'8787')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/index.ts"]
