# Example data packs

Ready-to-import data packs, one per card type plus a combined starter pack.
The pack format and the card line format are documented in
[CARD_FORMATS.md](../../CARD_FORMATS.md).

| Pack | Bank | Card type |
|---|---|---|
| `numbers-hanzi.json` | Numbers | 0 — hanzi (draw strokes + pick tone) |
| `capitals-flashcards.json` | Capitals | 1 — flashcard |
| `german-vocab.json` | German Vocab | 2 — reversible flashcard |
| `grammar-quiz.json` | Grammar Quiz | 3 — multiple choice |
| `chinese-sentences.json` | Sentences | 4 — cloze / fill in the blank |
| `true-false-grammar.json` | Correct or Not | 5 — is this correct? (true/false) |
| `starter-all-types.json` | all six above | every type |

The card files live in [`packs/`](packs/) and leave the id field empty — ids
are derived on first load, so hand-authored packs never need to compute them.

To try one in a real vault:

1. Copy the `packs/` folder into your vault root (the pack `filePath`s are
   vault-relative).
2. In Obsidian: *Settings → Hanzi Practice → Data Packs → Import*, pick the
   pack's `.json` file.
3. The banks appear under *Practice Banks* and are immediately practicable
   via the `practice` command.

These files are also loaded by `tests/example_data_packs.test.ts`, so they
are guaranteed to stay valid as the formats evolve.
