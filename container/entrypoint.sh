#!/bin/sh
# PiAgent runs every command with ctx.container.exec; the container only has to stay up.
# The egress CA is trusted from the host after start (src/sandbox.ts), since it appears only then.
exec sleep infinity
