#!/bin/sh
# Launch from any working directory. No client configuration is modified.
exec node "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/server.mjs" "$@"
