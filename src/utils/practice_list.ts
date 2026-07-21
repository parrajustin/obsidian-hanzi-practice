/**
 * The practice list file (`hanzi-practice-words.md`) stores one practice item
 * per line. To avoid loading the ~10MB CEDICT dictionary every time the
 * practice view opens, the item's pinyin (numeric, e.g. `hao3`) and English
 * definition are looked up ONCE when the character is added and cached on the
 * same line, tab-separated, together with the item's stable id:
 *
 *     好\thao3\tgood/appropriate; proper/all right!/...\t<id>
 *
 * The id is a hash of character+pinyin (see `computeEntryId`): a character can
 * have several senses with different pinyin (好 hao3 / 好 hao4), and each
 * sense is its own practice item with its own history. Lines without an id
 * (older format), and plain single-character lines (the oldest format), are
 * still parsed — missing ids are derived, missing pinyin/english are empty.
 */
export interface PracticeEntry {
  /**
   * Stable identity of this practice item: hash of character+pinyin. Reviews
   * in the history file are keyed by this id.
   */
  id: string;
  character: string;
  /** Numeric pinyin as stored in CEDICT, e.g. "hao3" or "han4 yu3". May be empty. */
  pinyin: string;
  /** English definition (CEDICT senses joined by "/"). May be empty. */
  english: string;
}

const FIELD_SEP = '\t';

/**
 * Stable id for a (character, pinyin) practice item: FNV-1a 32-bit over both
 * fields, as 8 hex chars. Pure string math — no Node `crypto` (mobile has no
 * Node runtime) — and deterministic, so the same sense always maps to the
 * same id across devices and sessions.
 */
export function computeEntryId(character: string, pinyin: string): string {
  const input = `${character}\u001f${pinyin}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Parse the whole practice-list file text into structured entries. */
export function parsePracticeList(text: string): PracticeEntry[] {
  const entries: PracticeEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split(FIELD_SEP);
    const character = parts[0].trim();
    if (character.length === 0) continue;
    const pinyin = (parts[1] ?? '').trim();
    const english = (parts[2] ?? '').trim();
    // Older lines predate the id field — derive it so every entry has one.
    const id = (parts[3] ?? '').trim() || computeEntryId(character, pinyin);
    entries.push({id, character, pinyin, english});
  }
  return entries;
}

/** Serialize one entry back to a single tab-separated line (no trailing newline). */
export function formatPracticeEntry(entry: PracticeEntry): string {
  const id = entry.id || computeEntryId(entry.character, entry.pinyin);
  return [entry.character, entry.pinyin, entry.english, id].join(FIELD_SEP);
}
