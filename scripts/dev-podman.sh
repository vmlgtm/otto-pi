#!/bin/sh
# `pnpm start` on a Mac with Podman instead of Docker. See NOTES.md, "Podman, and this Mac's network".
# Starts the socket proxy (drops HostConfig.MemorySwappiness, which crun rejects on cgroup v2)
# unless one is already listening, then runs the dev server with the container image built by Podman.
set -e
cd "$(dirname "$0")/.."
SOCK=/tmp/otto-docker.sock # macOS caps unix socket paths at 104 bytes
if ! curl -s --unix-socket "$SOCK" http://d/_ping >/dev/null 2>&1; then
  node scripts/podman-socket-proxy.mjs "$SOCK" &
  sleep 1
fi
export WRANGLER_DOCKER_BIN="$PWD/scripts/podman-as-docker.sh"
export DOCKER_HOST="unix://$SOCK"
exec pnpm start "$@"
