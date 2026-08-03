/**
 * The character ledger: one generated file holding every hanzi that appears in
 * any practice card, with its dictionary reading and meaning.
 *
 * It serves three jobs at once, which is why it is a normal card file rather
 * than a bespoke format:
 *   - it is the READING SOURCE the renderer annotates cards from, so the
 *     practice view never has to load the 10MB dictionary (the plugin's
 *     standing rule: enrich on write, keep the read path cheap);
 *   - it is a practiceable BANK, so the characters a study pack introduced can
 *     be drilled directly with the stroke quiz;
 *   - it is the human-readable PROGRESS note — the file opens with a table of
 *     level/reviews/average per character, regenerated whenever it is written.
 *
 * Progress itself is never stored as truth: levels are derived from the review
 * history every time they are read, so the table can go stale but the ledger
 * can never disagree with what was actually practiced.
 */

import {App} from 'obsidian';
import {
  FileSystemType,
  FileUtil,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Result, Ok} from 'standard-ts-lib/src/result';
import {StatusError} from 'standard-ts-lib/src/status_error';
import {Review} from '../spaced_repetition';
import {CharacterProgress, ProgressFor} from '../character_progress';
import {CedictParser} from '../dictionary/cedict_parser';
import {
  lookupDefinitions,
  PickPrimarySense,
} from '../dictionary/definition_lookup';
import {LogDebug, LogInfo, LogWarn} from '../telemetry/telemetry';
import {ExtractHanzi} from './hanzi_text';
import {prettifyPinyin} from './prettify_pinyin';
import {
  CHARACTER_BANK,
  CardType,
  HanziEntry,
  IsClozeEntry,
  IsFlashcardEntry,
  IsMultiChoiceEntry,
  IsTrueFalseEntry,
  PracticeEntry,
  computeEntryId,
  formatPracticeEntry,
  parsePracticeList,
} from './practice_list';

/** Everything the renderer needs about one character, keyed by the char. */
export interface CharacterIndexEntry extends CharacterProgress {
  /** Numeric CEDICT pinyin (`hao3`), as stored on the ledger line. */
  pinyin: string;
  /** Display form of the same reading (`hǎo`). */
  prettyPinyin: string;
  english: string;
  /** The entry id its reviews are keyed by. */
  id: string;
}

export type CharacterIndex = Map<string, CharacterIndexEntry>;

/** What one sync changed, for the log, the metrics and the user's Notice. */
export interface LedgerSyncSummary {
  total: number;
  added: number;
  /** Characters no dictionary sense was found for (stored without a reading). */
  unknown: string[];
  filePath: string;
}

/**
 * Every piece of a card a reader actually sees — the text whose characters the
 * card teaches. Answers and distractors count: seeing 车 in the answer is
 * still seeing it.
 */
export function CardTextForCharacters(entry: PracticeEntry): string {
  if (IsFlashcardEntry(entry)) return `${entry.front}\n${entry.back}`;
  if (IsMultiChoiceEntry(entry)) {
    return [entry.question, entry.answer, ...entry.distractors].join('\n');
  }
  if (IsClozeEntry(entry)) return `${entry.text}\n${entry.hint}`;
  if (IsTrueFalseEntry(entry)) return entry.statement;
  return entry.character;
}

/** The hanzi one card contributes to the ledger. */
export function CharactersInCard(entry: PracticeEntry): string[] {
  return ExtractHanzi(CardTextForCharacters(entry));
}

/** Read the ledger file's card lines (empty when it does not exist yet). */
export async function LoadLedgerEntries(
  app: App,
  filePath: string,
): Promise<HanziEntry[]> {
  const file = await FileUtil.fetchFile(app, filePath, FileSystemType.OBSIDIAN);
  if (!file.ok) return [];
  const text = new TextDecoder('utf-8').decode(file.val);
  return parsePracticeList(text).filter(
    (entry): entry is HanziEntry =>
      entry.cardType === CardType.HANZI && entry.character.length === 1,
  );
}

/**
 * The reading + level of every tracked character. `reviewsFor` supplies the
 * history (injected so callers that already parsed it do not re-read the
 * file, and so tests can drive levels directly).
 */
export async function LoadCharacterIndex(
  app: App,
  filePath: string,
  reviewsFor: (entry: HanziEntry) => Review[],
): Promise<CharacterIndex> {
  const index: CharacterIndex = new Map();
  for (const entry of await LoadLedgerEntries(app, filePath)) {
    const progress = ProgressFor(entry.character, reviewsFor(entry));
    index.set(entry.character, {
      ...progress,
      pinyin: entry.pinyin,
      prettyPinyin: entry.pinyin ? prettifyPinyin(entry.pinyin) : '',
      english: entry.english,
      id: entry.id,
    });
  }
  return index;
}

/**
 * Rebuild the ledger from every card in `entries`, keeping what is already
 * known and looking up only the characters that are new.
 *
 * Existing lines are preserved verbatim (id included), so a character keeps
 * the review history it has already earned and any hand-edited definition
 * survives a re-sync.
 */
export async function SyncCharacterLedger(
  app: App,
  filePath: string,
  entries: readonly PracticeEntry[],
  dictionary: CedictParser,
  progressFor: (entry: HanziEntry) => CharacterProgress,
): Promise<Result<LedgerSyncSummary, StatusError>> {
  const existing = await LoadLedgerEntries(app, filePath);
  const byChar = new Map<string, HanziEntry>(
    existing.map(entry => [entry.character, entry]),
  );

  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    // The ledger's own cards must not seed it — only what the study material
    // actually teaches decides which characters are tracked.
    if (entry.bank === CHARACTER_BANK) continue;
    for (const char of CharactersInCard(entry)) {
      if (seen.has(char)) continue;
      seen.add(char);
      wanted.push(char);
    }
  }

  const unknown: string[] = [];
  let added = 0;
  for (const char of wanted) {
    if (byChar.has(char)) continue;
    // NOT senses[0]: CEDICT's first sense is often a surname or a variant,
    // and an annotation with the wrong reading teaches the wrong thing.
    const sense = PickPrimarySense(lookupDefinitions(dictionary, char));
    if (!sense) {
      // Tracked anyway: a character with no dictionary sense still deserves a
      // level, and its missing reading is a fact the log should carry.
      unknown.push(char);
    }
    byChar.set(char, {
      id: computeEntryId(char, sense?.pinyin ?? ''),
      cardType: CardType.HANZI,
      bank: CHARACTER_BANK,
      character: char,
      pinyin: sense?.pinyin ?? '',
      english: sense?.english ?? '',
    });
    added++;
  }

  // First-appearance order of the study material, then anything the ledger
  // already tracked whose cards have since been edited away (never dropped —
  // that history is real).
  const retired = [...byChar.keys()].filter(char => !seen.has(char));
  const ordered = [...wanted, ...retired]
    .map(char => byChar.get(char))
    .filter((entry): entry is HanziEntry => entry !== undefined);

  const text = renderLedgerFile(ordered, progressFor);
  const written = await FileUtil.writeToFile(
    app,
    filePath,
    new TextEncoder().encode(text),
    FileSystemType.OBSIDIAN,
  );
  if (written.err) return written as unknown as Result<never, StatusError>;

  const summary: LedgerSyncSummary = {
    total: ordered.length,
    added,
    unknown,
    filePath,
  };
  LogInfo('Character ledger synced', {
    ...summary,
    unknownCount: unknown.length,
    // The full list would be unbounded; the count plus a sample is enough to
    // act on ("which characters has the dictionary never heard of?").
    unknown: unknown.slice(0, 20),
  });
  if (unknown.length > 0) {
    LogWarn('Characters tracked without a dictionary reading', {
      count: unknown.length,
      sample: unknown.slice(0, 20),
    });
  }
  return Ok(summary);
}

/** The progress table + the card lines, in one file. */
function renderLedgerFile(
  entries: readonly HanziEntry[],
  progressFor: (entry: HanziEntry) => CharacterProgress,
): string {
  const lines: string[] = [
    '# Character progress',
    '',
    // One comment PER LINE: the card parser skips a line that opens with
    // `<!--`, but a continuation line looks exactly like a card to it.
    '<!-- Generated by Hanzi Practice — command: "Sync Character Progress". -->',
    '<!-- The table is a snapshot; the card lines below it are the data. -->',
    '<!-- A character stops showing its pinyin on cards at level 4. -->',
    '',
    '| Character | Pinyin | Meaning | Level | Reviews | Avg |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const entry of entries) {
    const progress = progressFor(entry);
    const meaning = entry.english.split('/')[0]?.slice(0, 40) ?? '';
    lines.push(
      `| ${entry.character} | ${entry.pinyin ? prettifyPinyin(entry.pinyin) : '—'} | ` +
        `${meaning || '—'} | ${progress.level} | ${progress.reviewCount} | ` +
        `${progress.averageScore.toFixed(1)} |`,
    );
  }
  lines.push('', ...entries.map(formatPracticeEntry), '');
  LogDebug('Rendered character ledger file', {characters: entries.length});
  return lines.join('\n');
}
