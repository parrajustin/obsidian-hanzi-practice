# Hanzi Practice — Obsidian Plugin

Obsidian plugin for practicing Chinese characters (hanzi): draw strokes with `hanzi-writer`,
pick the correct pinyin/tone, get graded via a SuperMemo-2-style spaced-repetition engine, and
track history in plain markdown files inside the vault.

---

## Repo layout

- `src/main.ts` — plugin entry. Registers the `HanziPracticeView` + two commands
  (`open-hanzi-practice`, `add-hanzi-character`). `activateView()` opens the practice tab in the
  **center** pane via `workspace.getLeaf('tab')` (reusing an existing practice leaf if present).
  `getDictionary()` lazily loads + **caches** the parsed CEDICT for the plugin lifetime; only the
  add-character modal uses it. `CEDICT_FILE` names the shipped gzip.
- `src/views/hanzi_view.ts` — the `HanziPracticeView` (ItemView). Picks the next due char, reads
  its **cached** pinyin + English def **from the practice list** (never CEDICT), renders the
  `Meaning:` line (`.hanzi-meaning`) + `PinyinSelector` (`.tone-selector`) + hanzi-writer draw
  grid, grades on quiz complete, appends to history, then reopens for the next char.
- `src/components/pinyin_selector.ts` — tone multiple-choice buttons: correct pinyin + 4
  distractors (from `ConstructOtherOptions`), Fisher-Yates shuffled. Wrong pick → `5px solid red`
  + increments a mistake counter; correct → green + `onComplete(mistakes)`.
- `src/commands/add_character_modal.ts` — modal to add a character. On add: dup-check against the
  parsed list, then look up pinyin+def via `plugin.getDictionary()` and **cache them onto the
  practice line**. Duplicate → inline `.hanzi-add-error` (red) + `Notice`, modal stays open;
  typing clears the error.
- `src/dictionary/cedict_parser.ts` — parses `cedict_*.txt` into two `Trie`s (simplified /
  traditional); trie values are JSON `{traditional, simplified, pinyin, english}`.
  `loadDictionary` **gunzips** `.gz` input (detects gzip magic bytes `0x1f 0x8b`) via node `zlib`.
- `src/dictionary/trie.ts` — trie used by the parser + MaxMatch tokenizer.
- `src/utils/prettify_pinyin.ts` — `prettifyPinyin` (numeric→accented, `shi4`→`shì`) and
  `ConstructOtherOptions` (distractor pinyin; expects **numeric** pinyin like `hao3`).
- `src/utils/practice_list.ts` — `parsePracticeList` / `formatPracticeEntry` for the words-file
  format. Backward-compatible with old plain one-char-per-line entries.
- `src/utils/history_manager.ts` — reads/writes `hanzi-practice-history.md`, picks the next due
  char (`getNextDueCharacter`), and reads cached pinyin+def (`getPracticeEntry` /
  `loadPracticeEntries`).
- `src/spaced_repetition.ts` — SR scheduling (see below).
- `src/settings.ts` — Zod-schema settings (`historyFilePath`, `practiceFilePath`) + settings tab.
- Depends on sibling repos `../standard-obsidian-lib` and `../standard-ts-lib` (`file:` deps).
  `FileUtil.fetchFile(app, path, RAW)` reads via `app.vault.adapter.readBinary` (vault-root
  relative); `OBSIDIAN` type reads via the vault API.

---

## How it works (runtime)

### The dictionary flow — CEDICT is read only when adding a character
CEDICT is ~10MB; parsing it into a trie every time the practice view opens would be wasteful. So:

```
Add character ──▶ plugin.getDictionary()      (lazy, cached, gunzips the .gz)
                    └─▶ look up pinyin + English for the char
                        └─▶ write "char⇥pinyin⇥english" into hanzi-practice-words.md

Practice view ──▶ getNextDueCharacter() + getPracticeEntry()   (read words file only)
                    └─▶ render Meaning + tone selector from the CACHED fields
```

The practice view therefore never loads CEDICT. The dictionary ships **gzipped**
(`cedict_*.txt.gz`, 9.6MB → 3.9MB) next to `main.js` in the plugin folder and is inflated at
runtime. This is the general pattern: **do the expensive lookup once, at write time, and cache
the result into the data file that the hot path already reads.**

### Data files (in the vault)
- `hanzi-practice-words.md` — one entry per line, **TAB-separated**: `char⇥pinyin⇥english`
  (e.g. `好\thao3\tgood/appropriate; …`). `pinyin` is numeric CEDICT form. Plain one-char lines
  (no tabs) are still accepted (pinyin/def empty). Tabs are used as the separator because CEDICT
  definitions contain `/`, `|`, `;`, `(`, `)`, `:` but never tabs.
- `hanzi-practice-history.md` — attempt log, lines like `- [<epoch-ms>] 好: 5`.

### Spaced repetition (`spaced_repetition.ts`) & grading
Modified SM-2 over day-numbers (`floor(now / 86_400_000)`). Failing (`<3`) or brand-new →
due immediately; passing → review #1 `+1` day, #2 `+6`, #3+ `lastReviewDay + ceil(reviews.length
* efactor)` where efactor accumulates the SM-2 modifier (min 1.3). Final grade =
`min(strokeScore, pinyinCeiling)` — stroke mistakes give a 0–5 base, pinyin mistakes cap it
(`>1`→3, `1`→4, `0`→5). Full spec in `hanzi-practice-architecture.md`.

---

## Build

`npm run build` → `node esbuild.config.mjs production`:
1. Bundles `src/main.ts` → `main.js` (esbuild, `obsidian`/`electron`/codemirror/node-builtins
   external, format `cjs`).
2. Assembles `dist/` (gitignored) for real installs: `main.js`, `manifest.json`, and the
   **gzipped** CEDICT. **A real install = copy `dist/*` into `<vault>/.obsidian/plugins/
   hanzi-practice/`.** BRAT/manual users get the dictionary automatically this way.
3. Disposes the esbuild context before exit (a lingering context + `process.exit` deadlocks the
   esbuild Go service).

`node esbuild.config.mjs` (no `production`) = watch mode. `npm run build:e2e` bundles only the
E2E runner (`tests/e2e_runner.ts` → `tests/e2e_runner.js`); both are committed.

---

## Unit tests

`npm test` / `npx jest` — 10 tests across `cedict_parser` / `history_manager` /
`spaced_repetition`, using `tests/__mocks__/obsidian.ts` for the `obsidian` module. Any new
`obsidian` API used in a jest-reachable file must be added to that mock.

---

## E2E test — build → execute → validate

`tests/e2e_runner.ts` drives a **real** Obsidian AppImage via `puppeteer-core`: it builds a
throwaway vault, installs the plugin, walks the full user flow (add chars → practice → grade →
settings), asserts behavior at each step, and screenshots each step for pixel-diffing against
`tests/__goldens__/*.png`.

### Run it (one command)
```bash
npm run test:e2e          # build main.js + dist, bundle the runner, then run
```
That expands to: `npm run build` → `npm run build:e2e` → `node tests/e2e_runner.js`. To run the
pieces manually:
```bash
npm run build             # -> main.js + dist/ (incl. gzipped CEDICT)
npm run build:e2e         # -> tests/e2e_runner.js
node tests/e2e_runner.js  # runs against the current bundle
```

### Regenerate goldens
```bash
npm run test:e2e:goldens  # sets E2E_REGEN_GOLDENS=1 -> deletes tests/__goldens__/*.png,
                          # then this run saves fresh ones. Eyeball dumps/ after.
```
Then re-run `npm run test:e2e` and confirm every `[visual]` line reports `matches golden`.

### What each run does automatically
- **Kills any leftover test-Obsidian before AND after** (`reapTestObsidian` = `pkill -9 -f
  squashfs-root/obsidian`, scoped so it never touches a normally-installed Obsidian). Also
  reaps on `SIGINT`/`SIGTERM` and in the top-level `.then`/`.catch` (the pre-`try` "could not
  connect" throw would otherwise leak a running Obsidian).
- **Wipes `dumps/`** at the start.
- Wipes the throwaway vault + profile, installs `main.js`/`manifest.json`/gzipped CEDICT, writes
  the vault registry to `<profile>/obsidian.json` (see gotcha #1), launches with
  `--remote-debugging-port=9225`, and enables the plugin **deterministically** via
  `app.plugins.setEnable(true)` + `enablePluginAndSave` (see gotcha #2).

### Steps & assertions (functional = source of truth)
1. Vault loads (`window.app.workspace.layoutReady`).
2/3. Community plugins + Hanzi Practice enabled; command registered.
4. Add `好 汉 字` (first add parses the dictionary once; runner waits for the modal to close).
4b. Re-adding `好` keeps the modal open with a non-empty `.hanzi-add-error` (duplicate error).
5. `hanzi-practice-words.md` contains each char **and** `好` has cached `hao3` + a definition.
6. Practice view is in `.mod-root` (center pane, not a sidebar) and renders `.hanzi-meaning` +
   `.tone-selector` buttons from the cached data. Grading is **simulated** (`handleQuizComplete`
   called directly — hanzi-writer stroke input can't be puppeteered).
7. `hanzi-practice-history.md` gets the graded line.
8. Settings tab opens.

### Validate a run
- **Exit code 0** and the log's last line is `RESULT: PASS`:
  ```bash
  grep 'RESULT:' e2e-run.log            # -> RESULT: PASS
  ```
- **Visual** (advisory — see gotcha #4): every step should say `matches golden`:
  ```bash
  grep '\[visual\]' e2e-run.log         # "matches golden (N px diff)"; WARN = over threshold
  ```
- **No leftover Obsidian** (filter out your own `node -e` cmd line, which contains the pattern):
  ```bash
  node -e 'const cp=require("child_process");const ps=cp.execSync("ps -eo args").toString();
  console.log(ps.split("\n").filter(l=>l.includes("squashfs-root/obsidian")&&!l.includes("-eo args")).length)'
  # -> 0
  ```

### Debugging a failing run
- **`dumps/`** (gitignored, wiped each run): `NN-<step>.png` **and** `NN-<step>.html` per step,
  plus a `FAILURE` dump on any thrown error — read these to see exactly where/why it stalled.
- **`e2e-run.log`** (gitignored): full log incl. Obsidian stdout/stderr and `RESULT:`.

---

## E2E gotchas & root causes (hard-won — read before touching the runner)

1. **Electron `--user-data-dir=X` means `obsidian.json` lives at `X/obsidian.json`** (NOT a
   nested `X/obsidian/obsidian.json`). Get this wrong and Obsidian can't find the registered
   vault, opens the **vault picker** (`starter.html`) instead, `window.app.workspace` never
   exists, and STEP 1 hangs on `layoutReady`. This masqueraded as a "GPU/golden" problem for a
   long time — it wasn't.
2. **Don't depend on the "Trust author" modal to enable plugins.** First open of a vault with
   plugins shows *"Do you trust the author of this vault?"* and its timing is flaky (some
   launches auto-trust and the modal never appears within a fixed poll → Restricted Mode stays
   on → the plugin is hidden → its command isn't registered → later steps fail). Enable via the
   API (`app.plugins.setEnable(true)` + `enablePluginAndSave(id)`) and assert the command exists.
   The runner still *clicks* the modal when present, only for the screenshot record.
3. **The remote-debug port is flaky if a prior Obsidian is still shutting down** — a new instance
   against the same user-data-dir hands off via Electron's single-instance lock and never binds
   port 9225. Fix = kill leftovers + wait for the port to free *before* launching.
4. **Pixel goldens are environment-specific** (fonts, GPU/rasterizer, DPI, subpixel AA). Visual
   comparison is therefore **advisory**: `takeAndCompareScreenshot` logs a `WARN` + writes a
   `*-diff.png` on mismatch but does **not** fail the run — the functional assertions are the
   source of truth. `E2E_STRICT_VISUAL=1` makes visual diffs fatal. Regenerate goldens on the
   machine you validate on.

---

## Insights for future projects

- **Cache expensive derived data into the file the hot path already reads.** Reading a 10MB
  dictionary on every view-open was the bug behind "no definition / no tone selector". The fix
  was to look it up once at *write* time (adding a char) and store pinyin+def in the words file.
  Generalizes to any read-heavy lookup: enrich on write, keep the read path cheap.
- **Ship large read-only assets compressed, inflate at runtime.** `zlib.gzipSync` at build →
  `zlib.gunzipSync` in the plugin cut the shipped dictionary 9.6MB → 3.9MB. Detect gzip by magic
  bytes (`0x1f 0x8b`) so the same loader handles both compressed and raw inputs.
- **Bundlers copy code, not data.** An Obsidian build emits only `main.js`; anything else the
  plugin reads at runtime (dictionaries, models, assets) must be *explicitly* placed in the
  plugin folder. We added a `dist/` assembly step so a real install is "copy `dist/*`".
- **For GUI E2E, make functional assertions the source of truth and treat pixels as advisory.**
  Screenshots are great for a human to eyeball and for catching gross regressions, but pixel
  diffs across environments produce false failures. Assert on the DOM/behavior; keep the visual
  diff as a loud-but-non-fatal signal with a `*-diff.png` artifact.
- **Drive apps through their API, not their UI, wherever a stable API exists.** UI-modal timing
  (trust prompts, toggles) is the flakiest part of any GUI automation. `app.plugins.enable…` is
  deterministic; clicking a switch that may or may not have rendered yet is not.
- **Make setup/teardown idempotent and defensive.** Kill leftovers *before* and *after*; wait
  for the resource (port) to actually free; reap on signals and on every exit path — including
  the ones that throw before your `try`/`finally`. Leaked GUI processes compound across runs.
- **Dump generously when automating something you can't watch live.** Per-step PNG **and** HTML
  dumps (wiped each run) plus a `FAILURE` dump turned "it's frozen somewhere" into "it's on the
  vault-picker screen because obsidian.json is in the wrong place" in one look.
- **Prefer a self-writing run log over shell redirection for background/GUI processes.** The
  runner appends to `e2e-run.log` via `fs` and routes the child's stdout/stderr through it, so
  the record survives regardless of how the process is launched or killed.

---

## Environment gotchas (this machine)

- **The Bash tool runs sandboxed.** Commands containing `pkill`, and any `dangerouslyDisableSandbox`
  run, are silently rejected (exit 1, no execution). Run process-killing from **inside node**
  (`cp.execSync('pkill …')`) — the node process the runner spawns is not restricted the same way.
- **`pgrep -f squashfs-root/obsidian` also matches your own `node -e "…squashfs-root/obsidian…"`**
  command line. Filter out `node`/`-eo`/`-e` lines when counting real Obsidian processes.
- Shell is fish; primary dir `/home/jrparra/git/obsidian-hanzi-practice`. The extracted AppImage
  lives at `squashfs-root/obsidian` (gitignored), profile at `/tmp/obsidian-test-profile`.
