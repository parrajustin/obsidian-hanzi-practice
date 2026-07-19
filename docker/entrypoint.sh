#!/usr/bin/env bash
# Start a virtual X display, run the given command (default: the E2E), then copy
# artifacts out to a mounted /out volume if present.
set -u

# --- Virtual display so Electron/Obsidian can render headlessly ---
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY=:99

# Wait for the X socket to appear (no extra deps needed).
for _ in $(seq 1 50); do
  [ -S /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done

# Default command if none supplied.
if [ "$#" -eq 0 ]; then
  set -- node tests/e2e_runner.js
fi

"$@"
CODE=$?

# Publish dumps + log to the host. (Goldens are handled via a direct bind mount
# on tests/__goldens__ -> docker/__golden__, so nothing to copy for them.)
if [ -d /out ]; then
  cp -f e2e-run.log /out/ 2>/dev/null || true
  rm -rf /out/dumps 2>/dev/null || true
  cp -r dumps /out/dumps 2>/dev/null || true
fi

kill "$XVFB_PID" 2>/dev/null || true
exit $CODE
