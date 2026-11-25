#!/bin/sh
# Populate NODE_COMPILE_CACHE and smoke-test dist/web/server.mjs at image build.
# Success = the server finishes booting, then exits 0 on SIGTERM. Node writes
# the compile cache as it exits, so a server killed on the way leaves none.
#
# Readiness is the server's own `boot_timing` line (src/shared/lib/boot-timing.ts),
# not a fixed timer: the arm64 image builds under QEMU, where boot takes ~13s
# against ~1.5s natively, and a timer short enough for one is a race on the other.
set -eu

CACHE_DIR="${NODE_COMPILE_CACHE:-/app/.compile-cache}"
DATA_DIR=/tmp/sa-compile-warmup
LOG=/tmp/sa-compile-warmup.log
READY_TIMEOUT=120
mkdir -p "$CACHE_DIR"

# `timeout` passes our SIGTERM on to node and SIGKILLs it 5s later if it is
# still up (exit 137); its own deadline bounds a boot that never finishes.
SUPERAGENT_DATA_DIR="$DATA_DIR" E2E_MOCK=true PORT=39999 \
  timeout -k 5s "$((READY_TIMEOUT + 30))s" node dist/web/server.mjs >"$LOG" 2>&1 &
pid=$!

fail() {
  kill -KILL "$pid" 2>/dev/null || true
  cat "$LOG"
  echo "compile-cache warmup: $1" >&2
  exit 1
}

waited=0
until grep -q '^boot_timing ' "$LOG"; do
  kill -0 "$pid" 2>/dev/null || fail "server exited before it finished booting"
  [ "$waited" -lt "$READY_TIMEOUT" ] || fail "server did not finish booting within ${READY_TIMEOUT}s"
  sleep 1
  waited=$((waited + 1))
done

kill -TERM "$pid" 2>/dev/null || true
set +e
wait "$pid"
status=$?
set -e
cat "$LOG"

if [ "$status" -ne 0 ]; then
  echo "compile-cache warmup: expected a clean exit on SIGTERM, got $status" >&2
  exit 1
fi

# Node creates its versioned subdirectory up front, so check for cache files.
if [ -z "$(find "$CACHE_DIR" -type f | head -n 1)" ]; then
  echo "compile-cache warmup: no cache files in $CACHE_DIR" >&2
  exit 1
fi

chmod -R a+rwX "$CACHE_DIR"
rm -rf "$DATA_DIR" "$LOG"
