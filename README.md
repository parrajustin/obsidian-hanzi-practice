# obsidian-hanzi-practice

## Releasing

Releases are cut with [`release.sh`](release.sh) from the repo root on the
`main` branch. The script bumps the version in `manifest.json`,
`package.json`, and `versions.json`, runs the full test gate
(`tsc` + `eslint` + `jest`), builds `dist/` (which packs
`dist/hanzi-practice-<version>.tar.gz`), validates the tarball, commits and
tags the bump, pushes, and creates the GitHub release with the tarball
attached.

```sh
./release.sh            # patch bump (1.0.0 -> 1.0.1), the default
./release.sh patch      # same as above
./release.sh minor      # 1.0.0 -> 1.1.0
./release.sh major      # 1.0.0 -> 2.0.0
./release.sh 1.2.3      # explicit version (bare x.y.z, no leading "v")
```

Escape hatches:

```sh
SKIP_TESTS=1 ./release.sh minor     # skip the npm test gate
ALLOW_BRANCH=1 ./release.sh patch   # release from a branch other than main
```

Prerequisites:

- clean working tree (commit or stash first)
- authenticated GitHub CLI (`gh auth login`)
- `pnpm` on PATH (the script runs `pnpm install --frozen-lockfile` itself)

Notes:

- The git tag is the **bare version** (`1.1.0`, no `v` prefix) because the
  BRAT fork resolves releases by matching the release `tag_name` against
  `manifest.json`'s `version` exactly.
- The `.tar.gz` release asset is the real install path: the BRAT fork
  downloads it, extracts it, and installs every file it contains (including
  the gzipped CEDICT and stroke data). The loose `main.js`/`manifest.json`
  assets are only a fallback for the classic fixed-file flow and lack the
  data files. See `PACKAGE.md` in the MonoParra repo root for the full flow.
- If anything fails after the version bump but before the release commit,
  the script reverts the bump automatically so the tree stays clean.
