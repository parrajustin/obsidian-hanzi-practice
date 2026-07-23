/**
 * The practice list file stores one practice item ("card") per line,
 * TAB-separated. The plugin is a general practice platform: every card has a
 * card type (how it is practiced) and belongs to a bank (a named cluster of
 * cards practiced together, e.g. "Hanzi" or "Capitals").
 *
 * Line format (current, 6 fields):
 *
 *     <f0>\t<f1>\t<f2>\t<id>\t<cardType>\t<bank>
 *
 * Per card type the first three fields mean:
 *   - Hanzi (0):      character, numeric pinyin (e.g. `hao3`), English def.
 *     To avoid loading the ~10MB CEDICT dictionary every time the practice
 *     view opens, pinyin + definition are looked up ONCE when the character
 *     is added and cached on the line.
 *   - Flashcard (1) and reversible flashcard (2): front, back, (unused).
 *
 * Older hanzi lines are still parsed: 4-field lines (no cardType/bank),
 * 3-field lines (no id — derived), and plain single-character lines (the
 * oldest format) all become hanzi cards in the "Hanzi" bank.
 *
 * The hanzi id is a hash of character+pinyin (see `computeEntryId`): a
 * character can have several senses with different pinyin (好 hao3 / 好
 * hao4), and each sense is its own practice item with its own history.
 * Flashcard ids hash bank+front+back. Ids key the history file.
 */

/** How a card is practiced. Values are stored in the practice file — stable. */
export enum CardType {
  /** Draw the character's strokes + pick the pinyin tone. */
  HANZI = 0,
  /** Shown the front, recall the back, self-grade. */
  FLASHCARD = 1,
  /** Like FLASHCARD but either side may be shown as the prompt. */
  REVERSIBLE_FLASHCARD = 2,
}

/** The bank every hanzi card belongs to. */
export const HANZI_BANK = 'Hanzi';

/**
 * One place cards are stored: a bank name + the vault file holding its lines.
 * Each bank has its own file (the Hanzi bank's file is the plugin's
 * `practiceFilePath` setting; other banks are configured in settings).
 */
export interface BankSource {
  name: string;
  filePath: string;
}

interface BaseEntry {
  /** Stable identity of this card; history lines are keyed by it. */
  id: string;
  cardType: CardType;
  /** Named cluster of cards practiced together. */
  bank: string;
}

export interface HanziEntry extends BaseEntry {
  cardType: CardType.HANZI;
  character: string;
  /** Numeric pinyin as stored in CEDICT, e.g. "hao3" or "han4 yu3". May be empty. */
  pinyin: string;
  /** English definition (CEDICT senses joined by "/"). May be empty. */
  english: string;
}

export interface FlashcardEntry extends BaseEntry {
  cardType: CardType.FLASHCARD | CardType.REVERSIBLE_FLASHCARD;
  front: string;
  back: string;
}

export type PracticeEntry = HanziEntry | FlashcardEntry;

/**
 * Type guard for the two flashcard variants. Written so that entries with a
 * MISSING cardType (e.g. objects built by older callers or test harnesses)
 * fall through to the hanzi path, matching the file-format default.
 */
export function IsFlashcardEntry(
  entry: PracticeEntry,
): entry is FlashcardEntry {
  return (
    entry.cardType === CardType.FLASHCARD ||
    entry.cardType === CardType.REVERSIBLE_FLASHCARD
  );
}

const FIELD_SEP = '\t';

/**
 * FNV-1a 32-bit over the given parts (unit-separator joined), as 8 hex
 * chars. Pure string math — no Node `crypto` (mobile has no Node runtime) —
 * and deterministic, so the same card always maps to the same id across
 * devices and sessions.
 */
export function computeCardId(parts: string[]): string {
  const input = parts.join('\u001f');
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable id for a (character, pinyin) hanzi card. Kept exactly as it always
 * was (character+pinyin — bank/cardType NOT hashed) so existing history stays
 * attached to existing cards.
 */
export function computeEntryId(character: string, pinyin: string): string {
  return computeCardId([character, pinyin]);
}

/** Stable id for a flashcard: same card text in two banks = two cards. */
export function computeFlashcardId(
  bank: string,
  front: string,
  back: string,
): string {
  return computeCardId([bank, front, back]);
}

/**
 * Field values live on a single tab-separated line, so tabs/newlines inside
 * user text (flashcard fronts/backs, bank names) are collapsed to spaces.
 */
export function sanitizeField(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ').trim();
}

/** Parse the whole practice-list file text into structured entries. */
export function parsePracticeList(text: string): PracticeEntry[] {
  const entries: PracticeEntry[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split(FIELD_SEP);
    const f0 = parts[0].trim();
    if (f0.length === 0) continue;
    const f1 = (parts[1] ?? '').trim();
    const f2 = (parts[2] ?? '').trim();
    const id = (parts[3] ?? '').trim();
    const cardTypeRaw = parseInt((parts[4] ?? '').trim(), 10);
    // Lines predating card types are hanzi cards; unknown types are treated
    // as hanzi rather than dropped, so data written by a newer plugin version
    // still shows up (and can be removed) in an older one.
    const cardType =
      cardTypeRaw === CardType.FLASHCARD ||
      cardTypeRaw === CardType.REVERSIBLE_FLASHCARD
        ? cardTypeRaw
        : CardType.HANZI;
    const bank = (parts[5] ?? '').trim() || HANZI_BANK;
    if (cardType === CardType.HANZI) {
      entries.push({
        // Older lines predate the id field — derive it so every entry has one.
        id: id || computeEntryId(f0, f1),
        cardType,
        bank,
        character: f0,
        pinyin: f1,
        english: f2,
      });
    } else {
      entries.push({
        id: id || computeFlashcardId(bank, f0, f1),
        cardType,
        bank,
        front: f0,
        back: f1,
      });
    }
  }
  return entries;
}

/** Serialize one entry back to a single tab-separated line (no trailing newline). */
export function formatPracticeEntry(entry: PracticeEntry): string {
  if (IsFlashcardEntry(entry)) {
    const front = sanitizeField(entry.front);
    const back = sanitizeField(entry.back);
    const bank = sanitizeField(entry.bank);
    const id = entry.id || computeFlashcardId(bank, front, back);
    return [front, back, '', id, String(entry.cardType), bank].join(FIELD_SEP);
  }
  const id = entry.id || computeEntryId(entry.character, entry.pinyin);
  return [
    entry.character,
    entry.pinyin,
    entry.english,
    id,
    String(CardType.HANZI),
    sanitizeField(entry.bank || HANZI_BANK),
  ].join(FIELD_SEP);
}

/**
 * Human-readable "front (back)" label for notices and history lines. Long
 * flashcard text is truncated — the label is for people; ids key the data.
 */
export function entryLabel(entry: PracticeEntry): string {
  if (IsFlashcardEntry(entry)) {
    return `${truncate(sanitizeField(entry.front))} (${truncate(
      sanitizeField(entry.back),
    )})`;
  }
  return `${entry.character} (${entry.pinyin})`;
}

function truncate(value: string, max = 40): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Distinct bank names across the given entries, sorted, "Hanzi" first. */
export function listBanks(entries: PracticeEntry[]): string[] {
  const banks = [...new Set(entries.map(e => e.bank))].sort((a, b) =>
    a.localeCompare(b),
  );
  const hanziIdx = banks.indexOf(HANZI_BANK);
  if (hanziIdx > 0) {
    banks.splice(hanziIdx, 1);
    banks.unshift(HANZI_BANK);
  }
  return banks;
}
