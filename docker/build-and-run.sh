#!/usr/bin/env bash
# Build the E2E image and run it headlessly. Stages a temp build context that
# mirrors the monorepo layout (the plugin uses `file:../../common/standard-*`
# and `file:../obsidian-bug-collector` deps that live outside this repo, so the
# context must reach them), excluding heavy/generated dirs. Artifacts (dumps/,
# e2e-run.log, and regenerated goldens) are written back to docker-artifacts/
# on the host.
#
# Usage:
#   docker/build-and-run.sh                    # build + run the E2E
#   E2E_REGEN_GOLDENS=1 docker/build-and-run.sh npm run test:e2e:goldens
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARENT_DIR="$(dirname "$REPO_DIR")"
# The monorepo root (contains obsidian/ and common/) — the staged build
# context mirrors this layout so the file: deps resolve.
MONO_DIR="$(dirname "$PARENT_DIR")"
IMAGE="${HANZI_E2E_IMAGE:-hanzi-e2e}"
OUT_DIR="$REPO_DIR/docker-artifacts"
# Container-specific goldens live here (committed), separate from the host's
# tests/__goldens__. Bind-mounted over the container's golden dir so Docker runs
# compare against — and `:goldens` regenerates into — this directory directly.
GOLDEN_DIR="$REPO_DIR/docker/__golden__"
CONTAINER_GOLDEN_DIR="/workspace/obsidian/obsidian-hanzi-practice/tests/__goldens__"

# The AppImage is not committed (100MB GitHub limit) — fetch it if missing so
# the staged context contains it for the Dockerfile's extract step.
"$REPO_DIR/scripts/fetch_obsidian.sh"

# STEP 14 installs the Bug Collector into the test vault to assert this
# plugin's telemetry. Its main.js is gitignored (built, not committed), so
# build the sibling if it is missing — the same "ensure the prerequisite"
# contract as fetching the AppImage above.
COLLECTOR_DIR="$PARENT_DIR/obsidian-bug-collector"
if [ -d "$COLLECTOR_DIR" ] && [ ! -f "$COLLECTOR_DIR/main.js" ]; then
  echo ">> Building obsidian-bug-collector (its main.js is not committed)"
  (cd "$COLLECTOR_DIR" && npm run build)
fi

CTX="$(mktemp -d)"
cleanup() { rm -rf "$CTX"; }
trap cleanup EXIT

echo ">> Staging build context in $CTX"
stage_pkg() {
  # $1 is the repo path relative to the monorepo root (e.g.
  # obsidian/obsidian-hanzi-practice, common/standard-ts-lib); the staged
  # context keeps that layout so the file: deps resolve unchanged.
  local pkg="$1"
  [ -d "$MONO_DIR/$pkg" ] || { echo "!! missing sibling repo: $MONO_DIR/$pkg" >&2; exit 1; }
  mkdir -p "$CTX/$pkg"
  # tar-pipe with excludes: portable and doesn't copy the excluded trees at all.
  tar -C "$MONO_DIR/$pkg" \
      --exclude='./node_modules' \
      --exclude='./.git' \
      --exclude='./squashfs-root' \
      --exclude='./dumps' \
      --exclude='./dist' \
      --exclude='./docker-artifacts' \
      --exclude='./e2e-run.log' \
      --exclude='./component-run.log' \
      --exclude='./test_vault' \
      --exclude='./component_vault' \
      --exclude='./dumps-component' \
      -cf - . | tar -C "$CTX/$pkg" -xf -
}
stage_pkg obsidian/obsidian-hanzi-practice
stage_pkg common/standard-obsidian-lib
stage_pkg common/standard-ts-lib
stage_pkg obsidian/obsidian-bug-collector

echo ">> Building image: $IMAGE"
docker build -t "$IMAGE" -f "$REPO_DIR/docker/Dockerfile" "$CTX"

echo ">> Running E2E (headless, Xvfb)"
mkdir -p "$OUT_DIR" "$GOLDEN_DIR"

# Bind-mount the throwaway vault into docker-artifacts/ (desktop_vault or
# mobile_vault, matching the emulation mode) so its files can be inspected
# after — and even during — a run. Wiped here before every run; the runner
# additionally empties it (mount-point-safe) as part of its own setup. Not
# mounted for the component runner, which uses no vault content — and mounting
# would pointlessly wipe the previous E2E run's inspection copy.
VAULT_MOUNT=()
if [[ "$*" != *component_runner* ]]; then
  VAULT_NAME="desktop_vault"
  [ -n "${E2E_EMULATE_MOBILE:-}" ] && VAULT_NAME="mobile_vault"
  VAULT_DIR="$OUT_DIR/$VAULT_NAME"
  echo ">> Wiping $VAULT_DIR (vault will be inspectable there after the run)"
  rm -rf "$VAULT_DIR"
  mkdir -p "$VAULT_DIR"
  VAULT_MOUNT=(-v "$VAULT_DIR:/workspace/obsidian/obsidian-hanzi-practice/test_vault")
fi

docker run --rm \
  --shm-size=512m \
  -e E2E_REGEN_GOLDENS="${E2E_REGEN_GOLDENS:-}" \
  -e E2E_EMULATE_MOBILE="${E2E_EMULATE_MOBILE:-}" \
  -v "$OUT_DIR:/out" \
  -v "$GOLDEN_DIR:$CONTAINER_GOLDEN_DIR" \
  "${VAULT_MOUNT[@]}" \
  "$IMAGE" "$@"

echo ">> Done. Artifacts in $OUT_DIR (dumps/, e2e-run.log${VAULT_MOUNT:+, ${VAULT_NAME:-}/}); goldens in $GOLDEN_DIR"
