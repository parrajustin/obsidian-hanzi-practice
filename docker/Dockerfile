# Headless E2E for the Hanzi Practice Obsidian plugin.
#
# Runs the real Obsidian AppImage under Xvfb inside the container, so `npm run
# test:e2e` never opens a window on the host desktop or touches the host's
# Obsidian. ALL setup happens at build time: Electron/Chromium runtime libs,
# CJK fonts, dependency install, AppImage extraction, and the plugin/runner
# build. `docker run` then just executes the pre-built E2E.
#
# Build CONTEXT must contain the three repos as siblings (the plugin uses
# `file:../standard-*` deps); docker/build-and-run.sh stages that context.
FROM node:24-bookworm-slim

# --- System deps: Xvfb (virtual display), CJK fonts, Electron/Chromium libs ---
# fonts-noto-cjk is REQUIRED or every hanzi renders as tofu.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      fonts-noto-cjk \
      ca-certificates \
      libnss3 libnspr4 \
      libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
      libcups2 libdbus-1-3 libdrm2 libgbm1 \
      libgtk-3-0 libpango-1.0-0 libpangocairo-1.0-0 libcairo2 \
      libasound2 \
      libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 \
      libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxtst6 \
      libxkbcommon0 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# pnpm 11 to match the host (the repo's pnpm-workspace.yaml uses `allowBuilds:`,
# a pnpm 10/11 feature; older pnpm misreads it as a workspace manifest).
RUN npm install -g pnpm@11

WORKDIR /workspace

# Sibling file: deps first (change rarely -> better layer caching). The plugin's
# package.json references `file:../standard-*`, so the layout under /workspace
# mirrors the host: /workspace/{obsidian-hanzi-practice,standard-*}.
COPY standard-ts-lib/ ./standard-ts-lib/
COPY standard-obsidian-lib/ ./standard-obsidian-lib/

WORKDIR /workspace/obsidian-hanzi-practice

# Install deps using only the manifests first (cached until deps change).
COPY obsidian-hanzi-practice/package.json obsidian-hanzi-practice/pnpm-lock.yaml obsidian-hanzi-practice/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile || pnpm install

# The rest of the plugin repo (includes the committed Obsidian AppImage).
COPY obsidian-hanzi-practice/ ./

# Extract the AppImage at BUILD time. `--appimage-extract` self-extracts without
# FUSE, so no SYS_ADMIN/--device is needed at run time. Drop the 124MB AppImage
# afterwards to keep the image smaller.
RUN chmod +x Obsidian-1.12.7.AppImage \
    && ./Obsidian-1.12.7.AppImage --appimage-extract >/dev/null \
    && test -x squashfs-root/obsidian \
    && rm -f Obsidian-1.12.7.AppImage

# Pre-build the plugin (main.js + dist/ incl. gzipped CEDICT) and the E2E runner
# bundle, so `docker run` executes a ready image.
RUN npm run build && npm run build:e2e

ENV DISPLAY=:99
COPY obsidian-hanzi-practice/docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
# Default: run the pre-built E2E. Override, e.g. `docker run img npm run test:e2e:goldens`.
CMD ["node", "tests/e2e_runner.js"]
