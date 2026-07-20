#!/bin/bash
# Releases a new version of the hanzi-practice plugin for the BRAT-fork
# tar.gz flow (see /home/jrparra/git/MonoParra/PACKAGE.md):
#   1. bumps the version in manifest.json, package.json and versions.json
#   2. runs tests and builds dist/ (which emits hanzi-practice-<version>.tar.gz)
#   3. commits the bump, tags it with the BARE version (BRAT matches
#      release tag_name === manifest.version, so no "v" prefix) and pushes
#   4. creates the GitHub release with the tarball plus loose
#      main.js/manifest.json as a classic-flow fallback
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  echo "Usage: $0 [patch|minor|major|<version>]"
  echo "  patch|minor|major  bump the manifest.json version (default: patch)"
  echo "  <version>          explicit version, e.g. 1.2.3 (no leading v)"
  echo ""
  echo "Env: SKIP_TESTS=1 to skip npm test, ALLOW_BRANCH=1 to release off main"
  exit 1
}

BUMP="${1:-patch}"
case "$BUMP" in -h|--help) usage ;; esac

# --- preflight ---------------------------------------------------------------
command -v gh >/dev/null 2>&1 || { echo "error: GitHub CLI (gh) is required"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "error: pnpm is required"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh is not authenticated (gh auth login)"; exit 1; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is not clean, commit or stash first"
  exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ] && [ "${ALLOW_BRANCH:-}" != "1" ]; then
  echo "error: on branch '$BRANCH' — BRAT reads manifest.json from the default"
  echo "branch HEAD, so releases must go out from main (ALLOW_BRANCH=1 to override)"
  exit 1
fi

CURRENT=$(node -p "require('./manifest.json').version")

case "$BUMP" in
  patch|minor|major)
    NEW_VERSION=$(node -e "
      const [ma, mi, pa] = '$CURRENT'.split('.').map(Number);
      const out = { major: [ma+1,0,0], minor: [ma,mi+1,0], patch: [ma,mi,pa+1] };
      console.log(out['$BUMP'].join('.'));
    ")
    ;;
  *)
    echo "$BUMP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || {
      echo "error: '$BUMP' is not patch/minor/major or a bare x.y.z version"
      usage
    }
    NEW_VERSION="$BUMP"
    ;;
esac

if git rev-parse -q --verify "refs/tags/$NEW_VERSION" >/dev/null; then
  echo "error: tag $NEW_VERSION already exists"
  exit 1
fi

echo "Releasing $CURRENT -> $NEW_VERSION"

# --- install deps + test (before touching any version files) -----------------
echo "Installing dependencies..."
pnpm install --frozen-lockfile

if [ "${SKIP_TESTS:-}" != "1" ]; then
  echo "Running tests..."
  pnpm run test
fi

# --- bump version files ------------------------------------------------------
# from here until the release commit, revert the bump on any failure so the
# working tree is left clean for a rerun
revert_bump() {
  echo "error: release failed, reverting version bump"
  git checkout -- manifest.json package.json
  if git ls-files --error-unmatch versions.json >/dev/null 2>&1; then
    git checkout -- versions.json
  else
    rm -f versions.json
  fi
}
trap revert_bump ERR
# manifest.json (tabs) and package.json (2 spaces) keep their own indentation;
# versions.json maps plugin version -> minAppVersion (Obsidian convention)
node - "$NEW_VERSION" <<'EOF'
const fs = require("fs");
const version = process.argv[2];

const rewrite = (file, mutate) => {
  const text = fs.readFileSync(file, "utf8");
  const indent = /\n(\s+)/.exec(text)?.[1] ?? "\t";
  const json = JSON.parse(text);
  mutate(json);
  fs.writeFileSync(file, JSON.stringify(json, null, indent) + "\n");
};

rewrite("manifest.json", (m) => { m.version = version; });
rewrite("package.json", (p) => { p.version = version; });

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const versions = fs.existsSync("versions.json")
  ? JSON.parse(fs.readFileSync("versions.json", "utf8"))
  : {};
versions[version] = manifest.minAppVersion;
fs.writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");
EOF

# --- build (after the bump so the tarball carries the new version) -----------
echo "Building dist/..."
pnpm run build

# --- verify the tarball the BRAT fork will install ---------------------------
PLUGIN_ID=$(node -p "require('./manifest.json').id")
TARBALL="dist/${PLUGIN_ID}-${NEW_VERSION}.tar.gz"
[ -f "$TARBALL" ] || { echo "error: build did not produce $TARBALL"; exit 1; }

for required in main.js manifest.json; do
  tar -tzf "$TARBALL" | grep -qx "$required" || {
    echo "error: $TARBALL is missing $required at the archive root"
    exit 1
  }
done

TARBALL_VERSION=$(tar -xzOf "$TARBALL" manifest.json | node -p "JSON.parse(fs.readFileSync(0)).version")
[ "$TARBALL_VERSION" = "$NEW_VERSION" ] || {
  echo "error: tarball manifest version ($TARBALL_VERSION) != $NEW_VERSION"
  exit 1
}

# --- commit, tag, push -------------------------------------------------------
git add manifest.json package.json versions.json
git commit -m "chore: release $NEW_VERSION"
trap - ERR
git tag "$NEW_VERSION"
git push origin HEAD "$NEW_VERSION"

# --- github release ----------------------------------------------------------
# the tarball is what the BRAT fork installs; loose main.js/manifest.json are
# the fallback for the classic fixed-file flow (note: the fallback misses the
# gzipped data files, so the tarball is the real install path)
echo "Creating GitHub release $NEW_VERSION..."
gh release create "$NEW_VERSION" \
  "$TARBALL" \
  dist/main.js \
  dist/manifest.json \
  --title "Release $NEW_VERSION" \
  --notes "Release $NEW_VERSION"

echo "Released $NEW_VERSION successfully!"
