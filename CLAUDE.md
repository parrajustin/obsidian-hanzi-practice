# Hanzi Practice — Obsidian Plugin

Obsidian plugin that is a general spaced-repetition practice platform (Anki-style). Every
practice item is a **card** with a **card type** (how it is practiced) belonging to a **bank**
(a named cluster of cards practiced together; the `practice` command picks one). Card types:

- **0 = hanzi** (the original & richest type; always in the `Hanzi` bank): draw strokes with
  the plugin's own minimal quiz writer (`src/writer/`, graded against a shipped stroke
  database of medians + glyph outlines — no hanzi-writer, no CDN) and pick the correct
  pinyin/tone; graded automatically from stroke + tone mistakes.
- **1 = flashcard**: shown the front, recall the back, flip, then self-grade via buttons
  (Very Easy=5 / Easy=4 / Hard=3 / Very Hard=2 / No Idea=0 — `FLASHCARD_GRADES` in
  `src/components/flash_card.ts`).
- **2 = reversible flashcard**: like 1, but either side may be shown as the prompt.

All types feed the same SuperMemo-2-style spaced-repetition engine and track history in plain
markdown files inside the vault. Ids (view type `hanzi-practice-view`, command ids, entry-id
hashes) intentionally keep their historical hanzi names — renaming them breaks user
hotkeys/history.

---

## Repo layout

- `src/main.ts` — plugin entry. Registers the `HanziPracticeView` + five commands
  (`open-hanzi-practice`, `practice` (choose-bank modal), `add-hanzi-character`,
  `add-flash-card`, `edit-hanzi-bank` — the last id kept for hotkey compat, it now edits ALL
  banks). `activateView(bank)` opens the practice tab in the
  **center** pane via `workspace.getLeaf('tab')` (reusing an existing practice leaf if
  present) and ALWAYS calls `setViewState` with `state: {bank}` so an open tab switches bank.
  `getDictionary()` lazily loads + **caches** the parsed CEDICT for the plugin lifetime; only the
  add-character modal uses it. `CEDICT_FILE` names the shipped gzip.
- `src/views/hanzi_view.ts` — the `HanziPracticeView` (ItemView). One view instance practices
  ONE bank (`bank` is view state via `setState`/`getState`, default `Hanzi`, so it persists in
  the workspace layout) and renders whatever UI the due card's type needs: flashcards get a
  `FlashCard` (flip + self-grade → `handleFlashcardGrade` appends history and advances);
  an empty non-Hanzi bank shows `.practice-empty`. Hanzi cards: picks the next due char, reads
  its **cached** pinyin + English def **from the practice list** (never CEDICT), renders the
  `Meaning:` line (`.hanzi-meaning`) + `PinyinSelector` (`.tone-selector`) + the quiz writer's
  draw box, grades on quiz complete, appends to history, then reopens for the next char. Gets
  the char's stroke data from `plugin.getStrokeData()` (lazy, cached; `.hanzi-no-stroke-data`
  message if the char isn't in the database). Two controls under the draw box: **Give Up**
  (reveals outline + animation; sets a `gaveUp` flag so the attempt scores **0** even if the
  user then traces every stroke correctly) and **Mix Up** (`.hanzi-mix-up`;
  `HistoryManager.getMixUpEntry` swaps in a random *different* character whose average SR
  score is within 0.5 of the current one, else `Notice` "No other character with valid score
  range").
- `src/writer/` — the in-repo replacement for `hanzi-writer` (quiz-only). `quiz_writer.ts` is
  `HanziQuizWriter`: renders an SVG, captures pointer strokes (and swallows raw touch events
  with non-passive `preventDefault` + `touch-action: none`, so drawing can't trigger the
  mobile back-swipe/scroll), grades each against the current stroke's median, and after 3
  misses on the same stroke highlights it as a hint (`.hanzi-stroke-hint`, orange, static
  until the stroke passes). Completed strokes (`.hanzi-stroke-done`), hints, outlines and the
  give-up animation all render the character's REAL glyph outline shapes (filled paths from
  the stroke DB, drawn in a data-space-transformed `<g>`; the animation sweeps a fat median
  stroke inside a `clipPath` of the outline — hanzi-writer's technique), falling back to a
  round-capped median polyline for strokes with no outline;
  `showOutline()`/`animateCharacter()` back the Give Up flow.
  `stroke_matcher.ts` is a simplified port of hanzi-writer's `strokeMatches` (same five checks
  + thresholds: avg distance ≤350 (×0.5 after stroke 0), start/end ≤250, direction cosine >0,
  normalized-Fréchet ≤0.4, length ratio ≥0.35) except avg distance is measured to median
  *segments* (accurate on simplified polylines). `geometry.ts` has the curve math.
- `src/data/` — the stroke database (medians + glyph outlines). `stroke_codec.ts` defines the
  binary `HZS2` format (per char: codepoint + per stroke a length-prefixed record holding the
  median points AND the glyph-outline path tokenized to M/L/Q/C/Z commands, all coordinates
  zigzag-varint deltas from the previous point) with `encodeStrokeData` and the random-access
  `StrokeDataReader` (one linear scan builds a codepoint→offset index; each char decodes on
  demand — `get()` returns `{medians, outlines}` where outlines are ready-to-use SVG `d`
  strings). `stroke_data.ts` loads + gunzips `hanzi-strokes.bin.gz` from the plugin folder
  (same magic-byte pattern as CEDICT).
- `scripts/gen_stroke_data.ts` — build-time generator: reads the `hanzi-writer-data`
  **devDependency** (data source only — never shipped), keeps each stroke's median
  (simplified: Douglas-Peucker ε=10 of the 1024-unit box) + its glyph outline path, encodes +
  gzips. 47MB of per-char JSON → ~9MB binary → ~6.6MB shipped.
- `src/components/pinyin_selector.ts` — tone multiple-choice buttons: correct pinyin + 4
  distractors (from `ConstructOtherOptions`), Fisher-Yates shuffled. Wrong pick → `5px solid red`
  + increments a mistake counter; correct → green + `onComplete(mistakes)`.
- `src/commands/add_character_modal.ts` — modal to add a character. Typing looks up ALL CEDICT
  senses via `plugin.getDictionary()` + `lookupDefinitions` and renders them as clickable
  `.hanzi-def-option` buttons (pretty-tone pinyin + English; e.g. 好 → hǎo/hào). The **Add
  button stays disabled/greyed until a sense is selected**; a stale-lookup guard (`lookupSeq`)
  drops out-of-date results. On Add: dup-check **by entry id (char+pinyin)** — adding a second
  sense of the same char is allowed, re-adding the same sense is not — then **cache the
  SELECTED sense's pinyin+def+id onto the practice line**. Duplicate → inline
  `.hanzi-add-error` (red) + `Notice`, modal stays open; typing clears the error + selection.
- `src/commands/edit_bank_modal.ts` — `edit-hanzi-bank` command's modal: lists every practice
  entry (`.hanzi-bank-row`: char/pretty pinyin/English for hanzi, `.flash-bank-front`/`-back`
  for flashcards) with a `.hanzi-bank-remove` button, grouped under `.practice-bank-heading`
  headers **only when more than one bank exists** (a hanzi-only vault renders the same DOM as
  before — the E2E depends on it). Removal filters by entry id and rewrites the words file via
  `formatPracticeEntry` (also migrating old-format lines). History lines are never touched
  (they're a log).
- `src/commands/add_flashcard_modal.ts` — `add-flash-card` command's modal: bank
  **dropdown** (`.flash-bank-dropdown`, listing the banks configured in settings; a
  no-banks message points to Settings when empty), front/back textareas, reversible toggle
  (`.flash-reversible-toggle`). The card is **written to its bank's own file**
  (`bank.filePath`). Dup-check by id (`computeFlashcardId(bank, front, back)` — same text may
  live in two banks); duplicate → inline `.flash-add-error` + `Notice`. Stays open after a
  successful add (front/back clear, bank + toggle stick) for batch entry.
- `src/commands/practice_bank_modal.ts` — `practice` command's modal: one
  `.practice-bank-option` button per bank (name + card count) — every configured bank shows
  even with 0 cards, `Hanzi` listed first, plus any legacy bank tags found in files; picking
  one calls `plugin.activateView(bank)`.
- `src/components/flash_card.ts` — `FlashCard`: `.flash-card` (front, hidden back) +
  `.flash-card-flip` "Show Answer" button; flipping reveals the back and swaps in
  `.flash-card-grades` (one `.flash-card-grade` button per `FLASHCARD_GRADES` entry,
  `data-score` attr). One grade per card; grading an unseen answer is impossible.
- `src/dictionary/definition_lookup.ts` — `lookupDefinitions(dict, input)`: merges
  simplified+traditional trie hits, dedupes identical payloads, JSON-parses each sense
  (via `WrapToResult`, skipping malformed ones). Unit-tested in `tests/definition_lookup.test.ts`.
- `src/dictionary/cedict_parser.ts` — parses `cedict_*.txt` into two `Trie`s (simplified /
  traditional); trie values are JSON `{traditional, simplified, pinyin, english}`.
  `loadDictionary` **gunzips** `.gz` input (detects gzip magic bytes `0x1f 0x8b`) via node `zlib`.
- `src/dictionary/trie.ts` — trie used by the parser + MaxMatch tokenizer.
- `src/utils/prettify_pinyin.ts` — `prettifyPinyin` (numeric→accented, `shi4`→`shì`) and
  `ConstructOtherOptions` (distractor pinyin; expects **numeric** pinyin like `hao3`).
- `src/utils/practice_list.ts` — the data model: `CardType` enum, `HANZI_BANK`, and
  `PracticeEntry` = `HanziEntry | FlashcardEntry` (discriminated on `cardType`; use
  `IsFlashcardEntry`, written so a MISSING cardType — e.g. objects injected by the E2E —
  falls through to the hanzi path). `parsePracticeList` / `formatPracticeEntry` for the
  words-file format, plus the id hashes (`computeCardId` = FNV-1a 32-bit over
  `\u001f`-joined parts → 8 hex chars; pure string math, no Node `crypto` — mobile-safe):
  `computeEntryId(char, pinyin)` (unchanged from the hanzi-only era — existing history must
  stay attached) and `computeFlashcardId(bank, front, back)`. Each (char, pinyin) sense is
  its own entry with its own `id`. `sanitizeField` collapses tabs/newlines in user text so
  the line format survives. Backward-compatible: 4-field lines get cardType 0 + bank `Hanzi`,
  3-field lines also derive the id, plain one-char lines parse with empty pinyin/def; unknown
  card types parse as hanzi (forward compat) rather than being dropped. `listBanks` returns
  distinct banks, `Hanzi` first.
- `src/utils/history_manager.ts` — reads/writes `hanzi-practice-history.md` **keyed by entry
  id** (`parseHistory` also accepts legacy char-keyed lines; `reviewsForEntry` merges id-keyed
  + legacy reviews oldest-first — legacy attribution applies to hanzi cards only), loads all
  banks' files (`loadAllPracticeEntries(app, sources)` — **the file a card lives in decides
  its bank**, except lines in the Hanzi file which keep their line-level bank tag: that file
  held every bank's cards before per-bank files existed), and picks the next due entry **per
  bank** (`getNextDueEntry(app, historyPath, sources, bank)` — senses of the same char
  schedule independently; `getMixUpEntry` is hanzi-only and stays in the current bank).
- `src/spaced_repetition.ts` — SR scheduling (see below).
- `src/settings.ts` — Zod-schema settings, now **v1** (SchemaManager migration from v0 adds
  `banks: []`): `historyFilePath`, `practiceFilePath` (the Hanzi bank's file), and
  `banks: {name, filePath}[]` — **each bank stores its cards in its own file**, exactly like
  the Hanzi bank's words file. `bankSources(settings)` flattens that into the `BankSource[]`
  (Hanzi first) that all read paths consume. The settings tab's "Practice Banks" section is a
  LIST — one row per bank (`.hanzi-bank-row-setting`: name `.hanzi-bank-name` + file path
  `.hanzi-bank-path` text fields and a trash `.hanzi-bank-delete` remove button that only
  drops the config, never the file) — plus an "Add Bank" button (`.hanzi-bank-add`) that
  appends a row. **`hide()` (settings closed) re-parses every bank file** and shows a Notice
  with per-bank card counts, so path edits take effect (and typos surface) immediately.
- Depends on sibling repos `../standard-obsidian-lib` and `../standard-ts-lib` (`file:` deps).
  `FileUtil.fetchFile(app, path, RAW)` reads via `app.vault.adapter.readBinary` (vault-root
  relative); `OBSIDIAN` type reads via the vault API.

---

## How it works (runtime)

### The dictionary flow — CEDICT is read only when adding a character
CEDICT is ~10MB; parsing it into a trie every time the practice view opens would be wasteful. So:

```
Add character ──▶ typing triggers plugin.getDictionary()  (lazy, cached, gunzips the .gz)
                    └─▶ list ALL senses (pretty pinyin + English); user selects one
                        └─▶ Add enables ─▶ write "char⇥pinyin⇥english" into hanzi-practice-words.md

Practice view ──▶ getNextDueEntry()   (reads words + history files only; per-sense SR)
                    └─▶ render Meaning + tone selector from the CACHED fields
```

The practice view therefore never loads CEDICT. The dictionary ships **gzipped**
(`cedict_*.txt.gz`, 9.6MB → 3.9MB) next to `main.js` in the plugin folder and is inflated at
runtime. This is the general pattern: **do the expensive lookup once, at write time, and cache
the result into the data file that the hot path already reads.**

### The stroke-data flow — shipped, not fetched
Stroke data (medians for grading + glyph outlines for rendering) ships with the plugin as
`hanzi-strokes.bin.gz` (~6.6MB, generated at build time from the `hanzi-writer-data`
devDependency; see `scripts/gen_stroke_data.ts`). The practice view calls
`plugin.getStrokeData()` (lazy, cached for the plugin lifetime), which gunzips the blob and
hands it to `StrokeDataReader` — per-character decode on demand. **No network is ever
needed**; the old hanzi-writer CDN dependency is gone.

### Data files (in the vault)
- **One file per bank**, all sharing the same line format: `hanzi-practice-words.md` holds
  the Hanzi bank; every settings-configured bank names its own file (e.g.
  `capitals-cards.md`). A card's bank comes from the file it lives in — except lines in the
  hanzi file, which keep their line-level bank tag (pre-per-bank-file data).
- Line format — one card per line, **TAB-separated**, 6 fields:
  `f0⇥f1⇥f2⇥id⇥cardType⇥bank`. For hanzi cards (type 0) f0/f1/f2 =
  char/pinyin/english (e.g. `好\thao3\tgood/appropriate; …\t<8-hex id>\t0\tHanzi`); for
  flashcards (types 1/2) f0/f1 = front/back, f2 empty. `pinyin` is numeric CEDICT form;
  hanzi `id` = `computeEntryId(char, pinyin)` (historical hash — unchanged), flashcard `id` =
  `computeFlashcardId(bank, front, back)`. A char can appear on several lines (one per
  sense). Old 4-field/3-field and plain one-char lines are still accepted (cardType 0 + bank
  `Hanzi` assumed; id derived when missing; pinyin/def empty). Tabs are used as the separator
  because CEDICT definitions contain `/`, `|`, `;`, `(`, `)`, `:` but never tabs — and
  `sanitizeField` keeps tabs/newlines out of flashcard text.
- `hanzi-practice-history.md` — attempt log, lines like `- [<epoch-ms>] <id> 好 (hao3): 5`
  (flashcards: `- [<epoch-ms>] <id> <front> (<back>): 3`, both sides truncated to 40 chars).
  Keyed by the entry id; the "front (back)" label is for human readability only, so the
  parser matches the leading 8-hex id + trailing score and ignores the freeform middle.
  Legacy lines (`- [<epoch-ms>] 好: 5`) still parse and are attributed to every current
  sense of that char (hanzi cards only — never to flashcards).

### Spaced repetition (`spaced_repetition.ts`) & grading
Modified SM-2 over day-numbers (`floor(now / 86_400_000)`). Failing (`<3`) or brand-new →
due immediately; passing → review #1 `+1` day, #2 `+6`, #3+ `lastReviewDay + ceil(reviews.length
* efactor)` where efactor accumulates the SM-2 modifier (min 1.3). Final grade =
`min(strokeScore, pinyinCeiling)` — stroke mistakes give a 0–5 base, pinyin mistakes cap it
(`>1`→3, `1`→4, `0`→5) — **unless Give Up was pressed, which locks the grade to 0** no matter
how the guided strokes are then traced. Flashcards skip all of that: the user self-grades
(`FLASHCARD_GRADES` button → 5/4/3/2/0) and that value feeds the scheduler directly. Full
spec in `hanzi-practice-architecture.md`.

---

## Build

`npm run build` → `node esbuild.config.mjs production`:
1. Bundles `src/main.ts` → `main.js` (esbuild, `obsidian`/`electron`/codemirror/node-builtins
   external, format `cjs`).
2. Assembles `dist/` (gitignored) for real installs: `main.js`, `manifest.json`, the
   **gzipped** CEDICT, and `hanzi-strokes.bin.gz` (the generator is TS sharing the runtime
   codec, so the config bundles it to `node_modules/.cache/hanzi-gen/` and runs it with node).
   **A real install = copy `dist/*` into `<vault>/.obsidian/plugins/hanzi-practice/`.**
   BRAT/manual users get both data files automatically this way.
   Also packs those four files into `dist/hanzi-practice-<version>.tar.gz` (`emitTarball`) —
   the release asset our BRAT fork downloads, extracts, and fully installs (it needs
   `main.js` + `manifest.json` at the archive root; stale-version tarballs are deleted).
   See `/home/jrparra/git/MonoParra/PACKAGE.md` for the full release/BRAT flow.
3. Disposes the esbuild context before exit (a lingering context + `process.exit` deadlocks the
   esbuild Go service).

`node esbuild.config.mjs` (no `production`) = watch mode. `npm run build:e2e` bundles only the
E2E runner (`tests/e2e_runner.ts` → `tests/e2e_runner.js`); both are committed.

---

## Tests (`npm test` = type check → lint → unit)

`npm test` chains three gates (same pattern as pi-controller's `display_control_web`):
1. `test:ts` — `tsc --noEmit` over `src/`, `tests/`, `scripts/` (all in tsconfig `include`).
2. `lint` — `eslint .` with the **gts** flat config (`eslint.config.js` spreads `require('gts')`:
   eslint recommended + typescript-eslint recommended + prettier-as-a-rule, type-aware rules
   like `no-floating-promises` keyed off `./tsconfig.json`). Prettier style comes from gts via
   `.prettierrc.js` (single quotes, no bracket spacing, trailing commas, 80 cols). A
   `tests/**` override relaxes `no-explicit-any` / empty-catch / unused-catch-param (the
   puppeteer harnesses live on untyped `page.evaluate`); `src/` stays fully strict. Built
   bundles (`main.js`, `tests/*_runner.js`, `tests/component_harness.js`) and config `.mjs`/
   `jest.config.js` are ignored. `npm run lint:fix` / `npm run format` to auto-fix — but beware:
   `eslint . --fix` on *unformatted* code once produced broken output from overlapping fixes;
   run `npm run format` (plain prettier) first, then `lint:fix`.
3. `test:unit` — `npx jest`: 21 tests across `cedict_parser` / `history_manager` /
   `spaced_repetition` / `stroke_codec` (HZS1 round-trip incl. negative + astral-plane chars) /
   `stroke_matcher` (accepts median replay + jitter, rejects backwards/wrong/far strokes), using
   `tests/__mocks__/obsidian.ts` for the `obsidian` module. Any new `obsidian` API used in a
   jest-reachable file must be added to that mock.

Note: `typescript-eslint` is pinned to 8.62.1 via `pnpm-workspace.yaml` `overrides:` — gts's
`^8.46.1` range otherwise resolves to 8.64.0, which is only partially published on npm (its
`@typescript-eslint/utils` dep is missing) and breaks `pnpm install`.

---

## E2E test — build → execute → validate

`tests/e2e_runner.ts` drives a **real** Obsidian AppImage via `puppeteer-core`: it builds a
throwaway vault, installs the plugin, walks the full user flow (add chars → practice → grade →
settings), asserts behavior at each step, and screenshots each step for pixel-diffing against
`tests/__goldens__/*.png`.

### Run it (one command)
```bash
npm run test:e2e:docker   # build the image + run the E2E headless under Xvfb
```
The host (non-docker) e2e npm scripts were removed — the docker run is the only supported
way. It stages the build context, runs `npm run build` → `npm run build:e2e` →
`node tests/e2e_runner.js` inside the container, and copies artifacts to `docker-artifacts/`.

### Regenerate goldens
```bash
npm run test:e2e:docker:goldens  # E2E_REGEN_GOLDENS=1 -> regenerates docker/__golden__/*.png
```
Then re-run `npm run test:e2e:docker` and confirm every `[visual]` line reports `matches golden`.

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
4. Add `好 汉 字`: typing must grey out Add (`button.mod-cta` disabled), surface
   `.hanzi-def-option` entries (first add parses the dictionary once — generous timeout; 好 must
   show ≥2 senses), clicking an option must enable Add; runner then clicks Add and waits for the
   modal to close.
4b. Re-adding `好` (select a sense, click Add — dup-check runs on Add) keeps the modal open
   with a non-empty `.hanzi-add-error` (duplicate error).
5. `hanzi-practice-words.md` contains each char **and** `好` has cached `hao3` + a definition
   + an 8-hex entry id (4th field).
6. Practice view is in `.mod-root` (center pane, not a sidebar) and renders `.hanzi-meaning` +
   `.tone-selector` buttons from the cached data.
6b. Stroke quiz driven with REAL mouse input (puppeteer `page.mouse` → pointer events): a
   deliberately-wrong corner scribble ×3 (each must increment `view.strokeMistakes`), then the
   third miss must show the hint highlight (`.hanzi-stroke-hint`) — screenshotted as the
   `step6-stroke-hint` golden — then the correct stroke is drawn by replaying
   `writer.getStrokeDisplayPoints(0)` and must be accepted (index advances, hint clears,
   `.hanzi-stroke-done` renders). Full-quiz grading is then **simulated**
   (`handleQuizComplete` called directly) to exercise history writing.
7. `hanzi-practice-history.md` gets the graded line (`<id> 好 (hao3): <score>` — the grading
   simulation sets `view.currentEntry` from the words-file line read at step 5).
7b. `edit-hanzi-bank` modal lists all 3 entries (`.hanzi-bank-row`); clicking 字's
   `.hanzi-bank-remove` drops the row and rewrites the words file without 字 (好/汉 intact).
8. Settings tab opens.
9. Flashcards, end to end. 9a: drives the settings **Practice Banks** list UI with real
   clicks — "Add Bank" twice, renaming/repathing each new row via its
   `.hanzi-bank-name`/`.hanzi-bank-path` fields (the LAST match = newest row) — creating
   `Capitals` → `capitals-cards.md` and `German` → `german-cards.md`; asserts both rows are
   in the list; closing settings fires the hide() re-parse; asserts `plugin.settings.banks`. 9b: `add-flash-card`
   modal (bank picked in the `.flash-bank-dropdown`, front `France`, back `Paris`, typed with
   real key events) → Add writes the 6-field line (`France⇥Paris⇥⇥<id>⇥1⇥Capitals`, id =
   `computeFlashcardId` — the runner imports it from `src/utils/practice_list`) **into
   capitals-cards.md** (and asserts it did NOT leak into the hanzi words file); the modal
   stays open. 9c: `practice` command lists banks (`Hanzi` first, `German` present with 0
   cards) → clicking `Capitals` switches the open practice view to the bank; `.flash-card`
   shows the front with back + grades hidden; `.flash-card-flip` reveals `Paris` and exactly
   the 5 grade buttons (labels + `data-score` 5/4/3/2/0); clicking Easy appends
   `<id> France (Paris): 4` to history and the view advances (same card again — only card in
   the bank). Before the step9 screenshots the runner REMOVES all `.notice` toasts: their 5s
   fade timers are run-timing dependent and were the one source of golden flake.
10. Reversible flashcard, deliberately **non-visual** (which side is the prompt is random):
   adds `dog`/`Hund` to `German` with the reversible toggle ON → asserts the
   `dog⇥Hund⇥⇥<id>⇥2⇥German` line in `german-cards.md`; practices the `German` bank —
   asserts the prompt is one of the two sides, the flip reveals the OTHER side, and grading
   Very Easy appends `<id> dog (Hund): 5` (the history label always uses the stored
   front (back), independent of the side shown). Dumps only, no goldens.

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

### The Docker E2E environment (fully headless — no host windows)
```bash
npm run test:e2e:docker            # build the image + run the E2E under Xvfb
npm run test:e2e:docker:goldens    # same, but regenerate goldens inside the container
```
- **`docker/Dockerfile`** — `node:24-bookworm-slim` + Xvfb + **`fonts-noto-cjk`** (required, else
  hanzi render as tofu) + the Electron/Chromium runtime libs. Does **all** setup at build time:
  `pnpm install` (uses **pnpm 11** — the repo's `pnpm-workspace.yaml` `allowBuilds:` is a pnpm
  10/11 feature; pnpm 9 misreads it), **extracts the AppImage** (`--appimage-extract`, no FUSE,
  then deletes the 124MB AppImage), and pre-builds `main.js`/`dist`/the runner bundle.
- **`docker/entrypoint.sh`** — starts `Xvfb :99`, sets `DISPLAY=:99`, runs the E2E, and copies
  `dumps/` + `e2e-run.log` (and regenerated `__goldens__/`) to the mounted `/out`.
- **`docker/build-and-run.sh`** — stages a temp build context containing the three repos as
  siblings (needed for the `file:../standard-*` deps that live outside this repo), builds, and
  runs with `--shm-size=512m`, mounting `docker-artifacts/` (gitignored) as `/out` **and**
  `docker/__golden__` over the container's `tests/__goldens__`.
- **The test vault is inspectable after every E2E run**: the container's throwaway vault
  (`test_vault`) is bind-mounted to `docker-artifacts/desktop_vault` (or `mobile_vault` under
  `E2E_EMULATE_MOBILE=1`), so the exact `hanzi-practice-words.md` / `hanzi-practice-history.md`
  / `.obsidian/` state the run produced survives on the host (live during the run, too). The
  script wipes that directory before each run, and the runner's own vault wipe deletes the
  dir's CONTENTS (never the dir — a mount point can't be `rm`'d, EBUSY). Component-runner
  invocations skip the mount (no vault content, and mounting would wipe the E2E's copy).
- **Container goldens live in `docker/__golden__/` (committed)** — separate from the host's
  `tests/__goldens__` because the container renders **light** theme at **1024×800** vs the host's
  dark 1280×1000. The dir is **bind-mounted** over the container's golden path, so Docker runs
  compare against it and `:docker:goldens` regenerates straight into it (auto-populated on first
  run when empty). A container is a *fixed* render environment, so these goldens are reproducible
  across machines/CI — the ideal home for pixel goldens (see gotcha #4). Current run: all 9
  (incl. `step6-stroke-hint`) match.
- **Validate the same way**: `grep RESULT: docker-artifacts/e2e-run.log` → `RESULT: PASS`; inspect
  `docker-artifacts/dumps/*.png`. Functional assertions all pass; leaves **0** processes on the host.
- Image is ~2.1 GB (Electron libs + CJK fonts + extracted app). First build is slow (base image +
  apt + `pnpm install`); layers cache so re-runs are fast.

### Mobile-emulation E2E (documents why the plugin fails on phones)

```bash
npm run test:e2e:docker:mobile   # headless in the container
```

- `E2E_EMULATE_MOBILE=1` makes the runner call `app.emulateMobile(true)` (per
  https://docs.obsidian.md/Plugins/Getting+started/Mobile+development) right after connecting.
  **`emulateMobile` persists a flag and RELOADS the window** — checking `app.isMobile`
  immediately after the call reads `false`; the runner polls, re-attaches to the reloaded
  page (`findWorkspacePage`), and forces one reload itself if nothing happens. After that the
  body has `emulate-mobile is-mobile` (+`is-tablet` at the container's 1024×800 — Electron's
  CDP lacks `Browser.setWindowBounds`, so the phone-size resize is best-effort only).
- Goldens get a `mobile-` prefix; `E2E_REGEN_GOLDENS=1` is prefix-scoped (desktop regen never
  deletes `mobile-*`/`component-*` and vice versa).
- **Obsidian's emulation also blocks Node builtins for plugins** — a faithful Capacitor
  simulation: each plugin `require('zlib')` logs
  `Error: [hanzi-practice] Attempting to load NodeJS package: "zlib"` and the plugin gets a
  dead module binding instead of Node's zlib.
- **STATUS (2026-07): mobile E2E PASSES end-to-end** (`RESULT: PASS` in the container, both
  desktop and mobile modes). It used to fail at STEP 5: the bundle's top-level
  `require("zlib")` (esbuild keeps Node builtins `external`) was rejected under mobile →
  `getDictionary()` errored → the add-modal wrote EMPTY cached pinyin/def (`好\t\t`). That
  was the Android bug. **The fix**: `src/utils/gunzip.ts` inflates with the web-standard
  `DecompressionStream('gzip')` (no Node zlib/Buffer anywhere in the shipped bundle — verify
  with `grep -c 'require("zlib")' main.js` → 0); `cedict_parser.ts` and `stroke_data.ts` use
  it. Gotcha inside the helper: do NOT await `writer.write()` before draining the readable
  (the write promise only resolves once output is consumed — awaiting first deadlocks), and
  `.catch(() => {})` the write/close promises so a corrupt-gzip error (which also surfaces
  via `reader.read()`) can't double-fire as an unhandled rejection. Unit-tested in
  `tests/gunzip.test.ts` (`@jest-environment node` — jsdom lacks DecompressionStream).

---

## Component golden test — the quiz writer in isolation

`tests/component_runner.ts` + `tests/component_harness.ts` test ONLY `src/writer` + `src/data`,
with no plugin, vault content, or Obsidian UI in frame. The runner launches the extracted
Obsidian AppImage purely as a Chromium host (empty vault → no trust prompt; port **9226** +
`/tmp/obsidian-component-profile`, separate from the E2E's so the suites can't
single-instance-lock each other), clears the window body, injects the bundled harness
(`tests/component_harness.js`), and mounts a lone `HanziQuizWriter` on a fixed 320px white
stage fed with the REAL shipped `dist/hanzi-strokes.bin.gz` (gunzipped in node → base64 →
`StrokeDataReader` in page). All input is synthetic pointer events at fixed coordinates and
every screenshot is **clipped to the stage**, so goldens contain nothing but the component —
pixel-stable and font-free.

```bash
npm run test:component                  # host (opens a window)
npm run test:component:goldens         # host, regenerate component-* goldens
npm run test:component:docker          # headless in the container
npm run test:component:docker:goldens  # regenerate container goldens (docker/__golden__)
```

Golden states (`component-*.png`, in `tests/__goldens__` / `docker/__golden__` alongside the
E2E's, **prefix-scoped**: each runner's `E2E_REGEN_GOLDENS=1` only deletes its own prefix):
`empty`, `ink` (mid-stroke, pointer held down), `hint` (3 misses on stroke 0), `progress`
(3 strokes accepted), `complete`, `outline`, `animation-start` (transitions disabled + huge
per-stroke delay ⇒ deterministic first-stroke-only frame), `animation-end`. Functional
assertions (mistake counts, hint show/clear, `onMistake`/`onCorrectStroke`/`onComplete`
payloads, animated-stroke counts) are the source of truth; pixel diffs stay advisory
(`E2E_STRICT_VISUAL=1` to make them fatal), with a tighter 100px-diff warning threshold since
the clips are small. Validate with `grep RESULT: component-run.log` → `RESULT: PASS`; debug via
`dumps-component/` (`component-run.log` and `dumps-component/` are copied to
`docker-artifacts/` on container runs).

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
   machine you validate on (host → `tests/__goldens__`, container → `docker/__golden__`).
5. **The quiz writer is created asynchronously** (the view awaits the gunzip + index of the
   shipped stroke DB before constructing it), so STEP 6 **polls for `view.writer` +
   `strokeCount > 0`** before driving the quiz — never assume an async load finished because a
   fixed `delay()` elapsed; poll for the actual state. (Historic version of this gotcha: the
   old hanzi-writer fetched stroke data from its CDN, so the container needed outbound network
   and a cold CDN exposed the race. Stroke data now ships with the plugin — no network needed.)

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
- **Containerize GUI E2E with Xvfb for isolation + reproducibility.** Running a GUI app's E2E on
  the dev desktop pops windows and couples goldens to the host's theme/DPI/fonts. A container with
  a virtual X display (`Xvfb`) fixes both: no windows escape, and the render environment is
  pinned. Keys that made it painless here: the AppImage extracts without FUSE (`--appimage-extract`,
  so no `--cap-add SYS_ADMIN`), the runner talks over a CDP port (display-agnostic), and it already
  passes `--no-sandbox --disable-gpu --disable-dev-shm-usage`. Watch-outs: install CJK/app fonts
  (or text renders as tofu), match the host package-manager version, and — because the deps live
  outside the repo (`file:../`) — stage a build context that includes the siblings.

---

## Environment gotchas (this machine)

- **The Bash tool runs sandboxed.** Commands containing `pkill`, and any `dangerouslyDisableSandbox`
  run, are silently rejected (exit 1, no execution). Run process-killing from **inside node**
  (`cp.execSync('pkill …')`) — the node process the runner spawns is not restricted the same way.
- **`pgrep -f squashfs-root/obsidian` also matches your own `node -e "…squashfs-root/obsidian…"`**
  command line. Filter out `node`/`-eo`/`-e` lines when counting real Obsidian processes.
- Shell is fish; primary dir `/home/jrparra/git/obsidian-hanzi-practice`. The extracted AppImage
  lives at `squashfs-root/obsidian` (gitignored), profile at `/tmp/obsidian-test-profile`.
- **Background vs foreground Bash calls can see DIFFERENT /tmp overlay views** (sandboxing).
  A log file written by a backgrounded command may be invisible (or stale) to later foreground
  `grep`/`ls` calls on the same path. Write run logs into the repo tree (e.g.
  `docker-artifacts/`) instead of /tmp or the scratchpad when a different shell needs to read
  them.
- **`squashfs-root/` can end up incompletely extracted** (seen 2026-07: `v8_context_snapshot.bin`
  missing → Obsidian dies instantly with `FATAL:gin/v8_initializer.cc Error loading V8 startup
  snapshot file` and the E2E fails with "port 9225 never became reachable"). Fix: `rm -rf
  squashfs-root && ./Obsidian-*.AppImage --appimage-extract`.
- **`docker build` may transiently fail resolving `node:24-bookworm-slim`** ("network is
  unreachable" on an IPv6 registry address) even when the `hanzi-e2e` image already exists.
  Workaround: skip `build-and-run.sh` and `docker run` the existing image directly with the
  same `-e E2E_REGEN_GOLDENS/-e E2E_EMULATE_MOBILE` and `-v` mounts it uses.
- **The Obsidian AppImage is NOT committed** (118MB > GitHub's 100MB blob limit — it was
  filter-branched out of history). `scripts/fetch_obsidian.sh` downloads the pinned version
  from Obsidian's official releases if missing (`--extract` also produces `squashfs-root/`
  for the host runners); `docker/build-and-run.sh` calls it automatically before staging.
  `*.AppImage` is gitignored — never commit it, and bump the pin in the fetch script to
  upgrade Obsidian versions.
