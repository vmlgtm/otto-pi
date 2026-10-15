# The workspace container one PiAgent session drives through ctx.container.
# Cloudflare runs linux/amd64; the build pins it so an arm64 Mac builds the same image.
FROM --platform=linux/amd64 node:22-trixie-slim AS node22

FROM --platform=linux/amd64 node:24-trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates coreutils procps findutils grep python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Node 24 is the default. A repo that needs Node 22 (src/repos.ts: node "22") gets
# /opt/node22/bin first on PATH.
COPY --from=node22 /usr/local/bin/node /opt/node22/bin/node
COPY --from=node22 /usr/local/lib/node_modules /opt/node22/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/node22/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/node22/bin/npx \
  && ln -s ../lib/node_modules/corepack/dist/corepack.js /opt/node22/bin/corepack \
  && corepack enable \
  && PATH=/opt/node22/bin:$PATH corepack enable --install-directory /opt/node22/bin

# The helper @cloudflare/sandbox's Files runs. The tag must equal the package version
# in package.json, or Files fails with SandboxProtocolError.
COPY --from=docker.io/cloudflare/sandbox:1.0.1 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# All egress is intercepted by the Worker (enableInternet: false), which terminates TLS
# with this CA. Tools that keep their own trust store are pointed at it too.
ENV CF_CA=/etc/cloudflare/certs/cloudflare-containers-ca.crt
ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt \
  NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
  npm_config_cafile=/etc/ssl/certs/ca-certificates.crt \
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  CI=1

# File operations for ContainerEnv: one Node process per call (src/container-env.ts).
COPY container/otto-fs.mjs /usr/local/lib/otto/otto-fs.mjs
COPY container/entrypoint.sh /usr/local/bin/otto-entrypoint
RUN chmod +x /usr/local/bin/otto-entrypoint && mkdir -p /workspace
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/otto-entrypoint"]
