/**
 * The practice list file (`hanzi-practice-words.md`) stores one character per
 * line. To avoid loading the ~10MB CEDICT dictionary every time the practice
 * view opens, the character's pinyin (numeric, e.g. `hao3`) and English
 * definition are looked up ONCE when the character is added and cached on the
 * same line, tab-separated:
 *
 *     好\thao3\tgood/appropriate; proper/all right!/...
 *
 * Plain single-character lines (the old format, and characters added before a
 * dictionary was available) are still parsed — their pinyin/english are empty.
 */
export interface PracticeEntry {
  character: string;
  /** Numeric pinyin as stored in CEDICT, e.g. "hao3" or "han4 yu3". May be empty. */
  pinyin: string;
  /** English definition (CEDICT senses joined by "/"). May be empty. */
  english: string;
}

const FIELD_SEP = '\t';

/** Parse the whole practice-list file text into structured entries. */
export function parsePracticeList(text: string): PracticeEntry[] {
  const entries: PracticeEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split(FIELD_SEP);
    const character = parts[0].trim();
    if (character.length === 0) continue;
    entries.push({
      character,
      pinyin: (parts[1] ?? '').trim(),
      english: (parts[2] ?? '').trim(),
    });
  }
  return entries;
}

/** Serialize one entry back to a single tab-separated line (no trailing newline). */
export function formatPracticeEntry(entry: PracticeEntry): string {
  return [entry.character, entry.pinyin, entry.english].join(FIELD_SEP);
}
