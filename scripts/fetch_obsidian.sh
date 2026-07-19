#!/usr/bin/env bash
# Ensure the Obsidian AppImage used by the E2E/component tests is present.
#
# The AppImage (~118MB) is NOT committed — it exceeds GitHub's 100MB blob
# limit — so it is downloaded on demand from Obsidian's official releases,
# pinned to the version below. Idempotent: does nothing if the file exists.
#
# Usage:
#   scripts/fetch_obsidian.sh            # download the AppImage if missing
#   scripts/fetch_obsidian.sh --extract  # ...and extract squashfs-root/ if
#                                        # missing (needed for the HOST e2e;
#                                        # the Docker build extracts its own)
set -euo pipefail

OBSIDIAN_VERSION="1.12.7"
APPIMAGE="Obsidian-${OBSIDIAN_VERSION}.AppImage"
URL="https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/${APPIMAGE}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

if [ ! -f "$APPIMAGE" ]; then
  echo ">> Downloading $APPIMAGE from official Obsidian releases..."
  curl -fL --progress-bar -o "$APPIMAGE.part" "$URL"
  mv "$APPIMAGE.part" "$APPIMAGE"
  chmod +x "$APPIMAGE"
  echo ">> Saved $APPIMAGE"
fi

if [ "${1:-}" = "--extract" ] && [ ! -x "squashfs-root/obsidian" ]; then
  echo ">> Extracting $APPIMAGE (no FUSE needed)..."
  chmod +x "$APPIMAGE"
  "./$APPIMAGE" --appimage-extract >/dev/null
  echo ">> Extracted to squashfs-root/"
fi
