#!/bin/sh
# Trust the Cloudflare containers CA (it appears at start, not at build), then idle.
# PiAgent runs every command with ctx.container.exec; nothing runs from here.
set -e
if [ -f "$CF_CA" ]; then
  cp "$CF_CA" /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
fi
exec sleep infinity
