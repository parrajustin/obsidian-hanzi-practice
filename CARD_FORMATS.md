# Card formats & data banks

How Hanzi Practice saves cards inside your vault, how practice banks are
loaded, and how to install a whole set of banks at once with a **data pack**
JSON file. Everything is plain text living in your vault — you can author or
edit any of it by hand.

## Where cards live

Every practice item is a **card** belonging to a **bank** (a named cluster of
cards practiced together). Each bank stores its cards in **one markdown file**:

- The built-in **Hanzi** bank uses the file named by the *Hanzi Practice File
  Path* setting (default `hanzi-practice-words.md`).
- Every other bank is configured in *Settings → Practice Banks* as a
  `name + file path` pair and stores its cards in its own file
  (e.g. `capitals-cards.md`).

## Card line format

A bank file holds **one card per line**, with **6 TAB-separated fields** plus
one optional trailing field (shown here as `⇥`):

```
f0 ⇥ f1 ⇥ f2 ⇥ id ⇥ cardType ⇥ bank [⇥ explanation]
```

- `id` — stable 8-hex-char identity of the card (FNV-1a hash; see below).
  History lines are keyed by it. If the field is empty it is derived on load.
- `cardType` — how the card is practiced: `0`–`5`, see the table below.
- `bank` — the bank name tag. Note: the file a card lives in decides its
  bank; this tag only matters inside the Hanzi file (see "How banks are
  loaded").
- `explanation` — optional **wrong-answer correction text**, available to
  every card type: the grammar rule behind a true/false statement, why a
  tempting multiple-choice pick is wrong, a mnemonic for a flashcard, … It is
  revealed only when you get the card wrong (see "Wrong answers &
  explanations" below), written only when non-empty, and ignored by older
  plugin versions.

Tabs are the separator because CEDICT definitions contain `/ | ; ( ) :` but
never tabs; card text is sanitized so tabs/newlines never appear inside a
field.

### Per card type

| Type | Name | f0 | f1 | f2 | id hashes |
|---|---|---|---|---|---|
| `0` | Hanzi (draw strokes + pick tone) | character | numeric pinyin (`hao3`, may be empty) | English definition (may be empty) | character + pinyin |
| `1` | Flashcard (front → back, self-graded) | front | back | *(empty)* | bank + front + back |
| `2` | Reversible flashcard (either side prompts) | front | back | *(empty)* | bank + front + back |
| `3` | Multiple choice (auto-graded) | question | correct answer | distractors joined by `\|` (option text never contains `\|`) | bank + question + answer |
| `4` | Cloze / fill-in-the-blank (self-graded) | sentence with each answer wrapped in `{{…}}` | optional hint/translation | *(empty)* | bank + sentence |
| `5` | Is this correct? / true-false (auto-graded) | the statement to judge | `true` or `false` — whether the statement is actually correct | *(empty)* | bank + statement |

### Examples (one of each)

```
好	hao3	good/appropriate	70b6d1dc	0	Hanzi
France	Paris		1c50e496	1	Capitals
dog	Hund		8b6ee5da	2	German
你__狗吗？	有没有	不有|没不有	b0e7a4d2	3	Grammar
我一个星期{{没}}吃饭。	I haven't eaten for a week.		e93c11f8	4	German
你有没有一只狗吗？	false		a1b2c3d4	5	Grammar	有没有 already forms the question — drop the 吗。
```

The last line shows the optional trailing `explanation` field (here on a
true/false card, but any type can carry one).

Notes:

- **Hanzi cards cache their pinyin + definition on the line** so the practice
  view never needs to load the 10MB CEDICT dictionary. A character can appear
  on several lines — one per sense (好 `hao3` / 好 `hao4`), each with its own
  id and its own practice history.
- **Multiple-choice ids do not hash the distractors**, so wrong options can be
  edited freely without resetting the card's history.
- **Ids hash the bank** (except hanzi), so the same flashcard text in two
  banks is two independent cards.
- **True/false ids hash only the bank + statement**, so a mislabeled card's
  verdict or explanation can be fixed without resetting its history. The
  verdict field must be the literal `true` to count as correct — anything
  else (including a hand-edit typo) reads as `false`. In the practice view
  the card renders as the multiple-choice UI with `Correct` / `Incorrect`
  options under an "Is this correct?" prompt.
- **Auto-graded cards (multiple choice and true/false) give no partial
  credit**: a clean first pick scores 5, any wrong pick fails the card with
  a 0 (the card comes back the same day).

### Wrong answers & explanations

When a card with an `explanation` is answered wrong, the correction is shown:

- **Multiple choice / true-false** — revealed the moment a wrong pick
  happens (and stays visible); a clean run never shows it.
- **Flashcards / cloze** — revealed when you self-grade below 3 (Very Hard
  or No Idea); passing grades keep it hidden.
- **Hanzi** — shown on the completion page when the final score is below 3.

After a failed card reveals its explanation, the view waits ~2.5 s before
advancing so the correction stays readable.

### Legacy lines (still accepted)

Older hanzi-only formats parse forever — they become hanzi cards in the
`Hanzi` bank, deriving the id when missing:

```
好	hao3	good/appropriate	70b6d1dc   ← 4 fields (pre-card-type)
好	hao3	good/appropriate           ← 3 fields (pre-id)
汉                                     ← bare character (oldest)
```

Unknown `cardType` values are parsed as hanzi cards rather than dropped, so
files written by a newer plugin version still show up in an older one.

## History file

Practice attempts append to the history file (default
`hanzi-practice-history.md`), one markdown list line per attempt:

```
- [1718712000000] 70b6d1dc 好 (hao3): 5
```

That is `- [<epoch-ms>] <card id> <human-readable label>: <score 0–5>`. Only
the timestamp, id, and score are parsed — the middle label is for people.
Cards key their history by id, so editing a card file never loses history as
long as the id (or the fields it hashes) stays the same.

## How banks are loaded

1. The settings produce the **bank source list**: the Hanzi bank's file
   first, then each configured bank's file (`bankSources` in
   `src/settings.ts`).
2. Each file is read from the vault and parsed line by line
   (`HistoryManager.loadAllPracticeEntries` →
   `parsePracticeList` in `src/utils/practice_list.ts`).
3. **The file a card lives in decides its bank** — a line's `bank` tag is
   overridden by the name of the bank whose file it sits in. The one
   exception is the Hanzi bank's file: its lines keep their line-level bank
   tags, because that file held every bank's cards before per-bank files
   existed, and that legacy data must stay practicable.
4. Closing the settings tab re-parses every bank file and shows a per-bank
   card count, so path typos surface immediately.

A bank configured with a missing file simply loads 0 cards — create the file
(or import cards into it) and it picks up on the next load.

## Data packs (JSON import)

A **data pack** is a JSON file that links practice banks to the markdown
files holding their cards, so a whole set of banks installs in one click:
*Settings → Data Packs → Import*, pick the `.json` file. The pack does not
contain cards — the linked markdown files (in the formats above) do.

Ready-to-import examples (one per card type plus a combined starter pack,
kept valid by the test suite) live in
[examples/data-packs/](examples/data-packs/).

### Format (version 1)

```json
{
  "version": 1,
  "name": "HSK 1 starter",
  "banks": [
    {"name": "Capitals", "filePath": "packs/capitals-cards.md"},
    {"name": "German", "filePath": "packs/german-cards.md"}
  ]
}
```

- `version` *(required)* — must be `1`.
- `name` *(optional)* — display name shown in the import confirmation.
- `banks` *(required)* — the banks to install; `filePath` is vault-relative
  and points at a card file in the line format above.
- `rules` *(reserved)* — future home for load rules (filtering, scheduling
  overrides, …). Parsed and ignored today, so packs that carry rules still
  import their banks.

Unknown extra keys are ignored (forward compatibility).

### Import semantics

Importing merges the pack's banks into *Settings → Practice Banks* **by bank
name** (implemented in `src/utils/data_pack.ts`):

- a name not configured yet → the bank is **added**;
- a name already configured with a different file path → that bank is
  **re-pointed** to the pack's path;
- a name already configured with the same path → **unchanged**;
- the reserved name `Hanzi` → **skipped** (the built-in Hanzi bank's file is
  the *Hanzi Practice File Path* setting, never a pack entry).

Nothing is ever deleted by an import, and card files are never written — the
pack only edits the bank configuration. A confirmation Notice reports the
added/updated/unchanged/skipped counts; a malformed pack imports nothing and
reports the first validation error.

### Typical workflow

1. Copy the pack's card files (e.g. `packs/capitals-cards.md`) into your
   vault, at the paths the pack's `filePath` entries name.
2. Copy the pack's `.json` file anywhere on the device.
3. *Settings → Data Packs → Import*, pick the `.json` — the banks appear in
   the Practice Banks list and are immediately practicable.
