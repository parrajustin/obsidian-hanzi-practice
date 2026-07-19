#!/usr/bin/env bash
# Build the E2E image and run it headlessly. Stages a temp build context that
# contains the three repos as siblings (the plugin uses `file:../standard-*`
# deps that live outside this repo, so the context must reach them), excluding
# heavy/generated dirs. Artifacts (dumps/, e2e-run.log, and regenerated goldens)
# are written back to docker-artifacts/ on the host.
#
# Usage:
#   docker/build-and-run.sh                    # build + run the E2E
#   E2E_REGEN_GOLDENS=1 docker/build-and-run.sh npm run test:e2e:goldens
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PARENT_DIR="$(dirname "$REPO_DIR")"
IMAGE="${HANZI_E2E_IMAGE:-hanzi-e2e}"
OUT_DIR="$REPO_DIR/docker-artifacts"
# Container-specific goldens live here (committed), separate from the host's
# tests/__goldens__. Bind-mounted over the container's golden dir so Docker runs
# compare against — and `:goldens` regenerates into — this directory directly.
GOLDEN_DIR="$REPO_DIR/docker/__golden__"
CONTAINER_GOLDEN_DIR="/workspace/obsidian-hanzi-practice/tests/__goldens__"

CTX="$(mktemp -d)"
cleanup() { rm -rf "$CTX"; }
trap cleanup EXIT

echo ">> Staging build context in $CTX"
stage_pkg() {
  local pkg="$1"
  [ -d "$PARENT_DIR/$pkg" ] || { echo "!! missing sibling repo: $PARENT_DIR/$pkg" >&2; exit 1; }
  mkdir -p "$CTX/$pkg"
  # tar-pipe with excludes: portable and doesn't copy the excluded trees at all.
  tar -C "$PARENT_DIR/$pkg" \
      --exclude='./node_modules' \
      --exclude='./.git' \
      --exclude='./squashfs-root' \
      --exclude='./dumps' \
      --exclude='./dist' \
      --exclude='./docker-artifacts' \
      --exclude='./e2e-run.log' \
      --exclude='./test_vault' \
      -cf - . | tar -C "$CTX/$pkg" -xf -
}
stage_pkg obsidian-hanzi-practice
stage_pkg standard-obsidian-lib
stage_pkg standard-ts-lib

echo ">> Building image: $IMAGE"
docker build -t "$IMAGE" -f "$REPO_DIR/docker/Dockerfile" "$CTX"

echo ">> Running E2E (headless, Xvfb)"
mkdir -p "$OUT_DIR" "$GOLDEN_DIR"
docker run --rm \
  --shm-size=512m \
  -e E2E_REGEN_GOLDENS="${E2E_REGEN_GOLDENS:-}" \
  -v "$OUT_DIR:/out" \
  -v "$GOLDEN_DIR:$CONTAINER_GOLDEN_DIR" \
  "$IMAGE" "$@"

echo ">> Done. Artifacts in $OUT_DIR (dumps/, e2e-run.log); goldens in $GOLDEN_DIR"
