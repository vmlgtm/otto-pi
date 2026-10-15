#!/bin/sh
# Wrangler and the Cloudflare Vite plugin call `docker build --provenance=false ...`.
# Podman has no --provenance flag, so drop it and pass everything else through.
# Use: export WRANGLER_DOCKER_BIN="$PWD/scripts/podman-as-docker.sh"
for arg do
  shift
  case "$arg" in
    --provenance|--provenance=*) continue ;;
  esac
  set -- "$@" "$arg"
done
exec "${PODMAN_BIN:-podman}" "$@"
