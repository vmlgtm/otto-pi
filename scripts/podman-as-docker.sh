#!/bin/sh
# Lets Wrangler and the Cloudflare Vite plugin use Podman where they call `docker`.
# Use: export WRANGLER_DOCKER_BIN="$PWD/scripts/podman-as-docker.sh"
#
# - `docker build --provenance=false`: Podman has no --provenance flag; drop it.
# - Build and push Docker v2 manifests, as Docker does (Podman's default is OCI).
# - Podman recompresses layers when it pushes, so the digest it records in RepoDigests
#   is not the manifest the registry got, and Cloudflare's image preparation then fails
#   with "The image is invalid or does not exist in this account". Pushes save the real
#   digest (--digestfile), and Wrangler's post-push `image inspect ... RepoDigests` of a
#   Cloudflare registry image is answered with it.
PODMAN="${PODMAN_BIN:-podman}"
CACHE="${TMPDIR:-/tmp}/otto-podman-digests"
command="$1"
for arg do
  shift
  case "$arg" in
    --provenance|--provenance=*) continue ;;
  esac
  set -- "$@" "$arg"
done

key() { printf %s "$1" | tr '/:@' '___'; }

case "$command" in
  build)
    shift
    exec "$PODMAN" build --format docker "$@"
    ;;
  push)
    shift
    for ref do :; done # the last argument is the image
    mkdir -p "$CACHE"
    digest_file="$CACHE/pushing.$$"
    "$PODMAN" push --format v2s2 --digestfile "$digest_file" "$@" || exit $?
    mv "$digest_file" "$CACHE/$(key "${ref%:*}")"
    exit 0
    ;;
  image)
    if [ "$2" = "inspect" ]; then
      ref="$3"
      case "$ref:$*" in
        registry.cloudflare.com/*RepoDigests*)
          saved="$CACHE/$(key "${ref%:*}")"
          if [ -f "$saved" ]; then
            printf '["%s@%s"]\n' "${ref%:*}" "$(cat "$saved")"
            exit 0
          fi
          ;;
      esac
    fi
    ;;
esac
exec "$PODMAN" "$@"
