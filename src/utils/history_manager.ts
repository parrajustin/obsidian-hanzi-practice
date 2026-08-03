import {App} from 'obsidian';
import {
  FileUtil,
  FileSystemType,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {SpacedRepetition, Review} from '../spaced_repetition';
import {CrossesKnownThreshold} from '../character_progress';
import {CharactersInCard} from './character_ledger';
import {Ok, Result} from 'standard-ts-lib/src/result';
import {StatusError} from 'standard-ts-lib/src/status_error';
import {
  LogDebug,
  LogError,
  LogErrorAsWarning,
  LogInfo,
  SetSpanAttribute,
  SetSpanAttributes,
  Span,
} from '../telemetry/telemetry';
import {
  BankSource,
  CardType,
  entryLabel,
  HANZI_BANK,
  HanziEntry,
  IsClozeEntry,
  IsFlashcardEntry,
  IsHanziEntry,
  IsMultiChoiceEntry,
  IsTrueFalseEntry,
  PracticeEntry,
  parsePracticeList,
} from './practice_list';
import {describeEntry} from '../telemetry/card_debug';

/**
 * History lines are keyed by the practice item's id (see `computeCardId` and
 * friends), because one character can be practiced as several senses with
 * different pinyin, and flashcards have no single-character identity at all.
 * A human-readable label ("front (back)") is ALSO written on the line so a
 * person reading the file can tell entries apart without decoding the id:
 *
 *     - [<epoch-ms>] <id> 好 (hao3): 5
 *     - [<epoch-ms>] <id> What is the capital of France? (Paris): 4
 *
 * The label is freeform (flashcard fronts contain spaces), so parsing keys
 * off the leading 8-hex id and the trailing score only. The old hanzi format
 * (`- [<epoch-ms>] 好: 5`) is still parsed; those reviews are keyed by the
 * bare character and attributed to every current sense of it.
 */
const HISTORY_LINE_REGEX = /- \[(\d+)\] ([0-9a-f]{8}) .*: (\d+)\s*$/;
const LEGACY_HISTORY_LINE_REGEX = /- \[(\d+)\] (.*?): (\d+)/;

/** True when this entry can actually be practiced by its card type's UI. */
function isPracticable(entry: PracticeEntry): boolean {
  if (IsFlashcardEntry(entry)) {
    return entry.front.length > 0;
  }
  if (IsMultiChoiceEntry(entry)) {
    return entry.question.length > 0 && entry.answer.length > 0;
  }
  if (IsClozeEntry(entry)) {
    return entry.text.length > 0;
  }
  if (IsTrueFalseEntry(entry)) {
    return entry.statement.length > 0;
  }
  // The drawing quiz models exactly one hanzi at a time.
  return entry.character.length === 1;
}

export class HistoryManager {
  /** Load and parse the practice list into structured entries. */
  @Span()
  static async loadPracticeEntries(
    app: App,
    practiceFilePath: string,
  ): Promise<PracticeEntry[]> {
    SetSpanAttribute('file.path', practiceFilePath);
    const practiceResult = await FileUtil.fetchFile(
      app,
      practiceFilePath,
      FileSystemType.OBSIDIAN,
    );
    if (!practiceResult.ok) {
      // A missing bank file is normal (an empty bank), so this is a
      // warning-level signal, not an error — but it still travels with the
      // full StatusError payload.
      LogErrorAsWarning('Practice file could not be read', practiceResult.val, {
        practiceFilePath,
      });
      return [];
    }
    const text = new TextDecoder('utf-8').decode(practiceResult.val);
    const entries = parsePracticeList(text);
    SetSpanAttribute('practice.entries', entries.length);
    return entries;
  }

  /**
   * Load the cards of EVERY bank, each from its own file. The file a card
   * lives in decides its bank — except cards in the Hanzi bank's file, which
   * keep their line-level bank tag (that file held every bank's cards before
   * per-bank files existed, and those legacy lines must stay practicable).
   */
  static async loadAllPracticeEntries(
    app: App,
    sources: BankSource[],
  ): Promise<PracticeEntry[]> {
    const all: PracticeEntry[] = [];
    for (const source of sources) {
      const entries = await this.loadPracticeEntries(app, source.filePath);
      for (const entry of entries) {
        if (source.name !== HANZI_BANK) {
          entry.bank = source.name;
        }
        all.push(entry);
      }
    }
    return all;
  }

  @Span()
  static async appendResult(
    app: App,
    historyFilePath: string,
    entry: PracticeEntry,
    score: number,
  ): Promise<void> {
    SetSpanAttributes({'card.id': entry.id, 'card.score': score});
    const timestamp = Date.now();
    const line = `- [${timestamp}] ${entry.id} ${entryLabel(entry)}: ${score}`;

    const appended = await this.appendLines(app, historyFilePath, [line]);
    // A failed write silently loses the user's practice result, which is
    // exactly the kind of invisible failure a bug report needs to carry.
    if (appended.err) {
      LogError('Failed to append practice result to history', appended.val, {
        historyFilePath,
        entryId: entry.id,
        score,
      });
      return;
    }
    const newText = appended.val;

    // WHAT WAS SAVED, for this exact card: the line as written, plus the
    // schedule that score just bought — a "why is this card back already"
    // (or "why has it vanished for a month") report is answered from here
    // alone. Parsed from the text already in hand; no second file read.
    const history = this.parseHistoryText(newText);
    const reviews = this.reviewsForEntry(history, entry);
    const dueDay = SpacedRepetition.calculateDueDayNumber(reviews);
    const today = SpacedRepetition.getCurrentDayNumber();
    LogInfo('Practice result saved to history', {
      ...describeEntry(entry),
      score,
      passed: score >= 3,
      historyFilePath,
      line: line.trim(),
      timestamp,
      reviewCount: reviews.length,
      averageScore: Number(this.averageScore(reviews).toFixed(2)),
      dueInDays: dueDay - today,
      dueAgainToday: dueDay <= today,
    });
  }

  /**
   * Append lines to the history file in ONE read-modify-write, returning the
   * file's new text so the caller can derive schedules from it without a
   * second read. Crediting a sentence's characters would otherwise be one
   * write per character.
   */
  private static async appendLines(
    app: App,
    historyFilePath: string,
    lines: readonly string[],
  ): Promise<Result<string, StatusError>> {
    const fileResult = await FileUtil.fetchFile(
      app,
      historyFilePath,
      FileSystemType.OBSIDIAN,
    );
    const current = fileResult.ok ? fileResult.val : new Uint8Array(0);
    const text = new TextDecoder('utf-8').decode(current);
    const newText = `${text}${lines.map(line => `\n${line}`).join('')}`;
    const written = await FileUtil.writeToFile(
      app,
      historyFilePath,
      new TextEncoder().encode(newText),
      FileSystemType.OBSIDIAN,
    );
    if (written.err) return written as unknown as Result<string, StatusError>;
    return Ok(newText);
  }

  /**
   * Credit every tracked character in a graded card with that card's score.
   *
   * Reading 你喜欢开车吗？correctly is evidence about 开 and 车, not just about
   * the card — this is what lets a character earn its way to level 4 (and lose
   * its pinyin) from sentences alone. Only characters already in the ledger are
   * credited: without a ledger line there is no id to key the reviews by, and
   * inventing one would orphan the history at the next sync.
   *
   * Returns the characters credited and those that crossed the
   * hide-the-pinyin threshold on this grade — the caller logs and counts them.
   */
  static async creditCharacters(
    app: App,
    historyFilePath: string,
    card: PracticeEntry,
    score: number,
    index: ReadonlyMap<string, {id: string; character: string}>,
  ): Promise<{credited: string[]; untracked: string[]; levelUps: string[]}> {
    const chars = CharactersInCard(card);
    const credited: string[] = [];
    const untracked: string[] = [];
    const lines: string[] = [];
    const timestamp = Date.now();
    for (const char of chars) {
      const tracked = index.get(char);
      if (!tracked) {
        untracked.push(char);
        continue;
      }
      credited.push(char);
      // The label names the card the credit came from, so a reader of the
      // history file can tell drills from sentence credit at a glance.
      lines.push(
        `- [${timestamp}] ${tracked.id} ${char} (via card ${card.id}): ${score}`,
      );
    }
    if (lines.length === 0) {
      if (untracked.length > 0) {
        LogDebug('Card had no tracked characters to credit', {
          cardId: card.id,
          untracked,
        });
      }
      return {credited, untracked, levelUps: []};
    }

    const before = await this.parseHistory(app, historyFilePath);
    const appended = await this.appendLines(app, historyFilePath, lines);
    if (appended.err) {
      LogError('Failed to credit characters', appended.val, {
        historyFilePath,
        cardId: card.id,
        characters: credited,
      });
      return {credited: [], untracked, levelUps: []};
    }
    const after = this.parseHistoryText(appended.val);

    const levelUps: string[] = [];
    for (const char of credited) {
      const tracked = index.get(char);
      if (!tracked) continue;
      const key = tracked.id;
      if (CrossesKnownThreshold(before[key] ?? [], after[key] ?? [])) {
        levelUps.push(char);
      }
    }
    LogInfo('Characters credited from a graded card', {
      cardId: card.id,
      cardType: card.cardType,
      score,
      credited,
      creditedCount: credited.length,
      untracked,
      // The characters whose pinyin disappears from now on.
      levelUps,
    });
    return {credited, untracked, levelUps};
  }

  /**
   * Parse the history file into reviews keyed by entry id (new format) or by
   * bare character (legacy format). Use `reviewsForEntry` to read the merged
   * per-entry view.
   */
  static async parseHistory(
    app: App,
    historyFilePath: string,
  ): Promise<Record<string, Review[]>> {
    const fileResult = await FileUtil.fetchFile(
      app,
      historyFilePath,
      FileSystemType.OBSIDIAN,
    );
    if (!fileResult.ok) {
      return {};
    }

    const decoder = new TextDecoder('utf-8');
    return this.parseHistoryText(decoder.decode(fileResult.val));
  }

  /**
   * The parser itself, over history text that has already been read — so a
   * caller holding the file contents (appendResult, which reads it to append)
   * does not read them a second time.
   */
  static parseHistoryText(text: string): Record<string, Review[]> {
    const lines = text.split('\n');

    const history: Record<string, Review[]> = {};

    for (const line of lines) {
      let key: string;
      let timestamp: number;
      let score: number;

      const match = line.match(HISTORY_LINE_REGEX);
      if (match) {
        timestamp = parseInt(match[1]);
        key = match[2];
        score = parseInt(match[3]);
      } else {
        const legacy = line.match(LEGACY_HISTORY_LINE_REGEX);
        if (!legacy) continue;
        timestamp = parseInt(legacy[1]);
        key = legacy[2].trim();
        score = parseInt(legacy[3]);
      }

      if (!history[key]) {
        history[key] = [];
      }
      history[key].push({timestamp, difficulty: score});
    }

    return history;
  }

  /**
   * All reviews that apply to one practice entry: id-keyed reviews plus (for
   * hanzi cards) any legacy character-keyed reviews (which predate per-sense
   * ids), oldest first — the order `SpacedRepetition.calculateDueDayNumber`
   * expects.
   */
  static reviewsForEntry(
    history: Record<string, Review[]>,
    entry: PracticeEntry,
  ): Review[] {
    // Legacy character-keyed lines predate every non-hanzi card type.
    const legacy = IsHanziEntry(entry) ? (history[entry.character] ?? []) : [];
    const reviews = [...(history[entry.id] ?? []), ...legacy];
    return reviews.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Average review score of one entry (0 when it has never been reviewed —
   * an unreviewed card counts as skill level 0).
   */
  static averageScore(reviews: Review[]): number {
    if (reviews.length === 0) return 0;
    return (
      reviews.reduce((sum, review) => sum + review.difficulty, 0) /
      reviews.length
    );
  }

  /**
   * "Mix up": a different hanzi in the same bank whose average
   * spaced-repetition score is within 0.5 of `current`'s, picked at random.
   * Other senses of the same character don't count as different. Null when no
   * character qualifies. (Hanzi-only — flashcards advance via grading.)
   */
  static async getMixUpEntry(
    app: App,
    historyFilePath: string,
    sources: BankSource[],
    current: PracticeEntry,
  ): Promise<PracticeEntry | null> {
    if (!IsHanziEntry(current)) return null;
    const allEntries = await this.loadAllPracticeEntries(app, sources);
    const entries = allEntries.filter(
      (e): e is HanziEntry =>
        e.cardType === CardType.HANZI &&
        e.bank === current.bank &&
        isPracticable(e),
    );
    const history = await this.parseHistory(app, historyFilePath);

    const currentAvg = this.averageScore(
      this.reviewsForEntry(history, current),
    );
    const candidates = entries.filter(
      entry =>
        entry.character !== current.character &&
        Math.abs(
          this.averageScore(this.reviewsForEntry(history, entry)) - currentAvg,
        ) <= 0.5,
    );
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  /**
   * The next card due for review in one bank: the most overdue due card, or
   * (when nothing is strictly due) the card with the earliest due date.
   */
  @Span()
  static async getNextDueEntry(
    app: App,
    historyFilePath: string,
    sources: BankSource[],
    banks: string | string[],
  ): Promise<PracticeEntry | null> {
    // One bank or several practiced together — the union schedules as one
    // pool (most-overdue card first, regardless of which bank it is in).
    const bankSet = new Set(typeof banks === 'string' ? [banks] : banks);
    SetSpanAttribute('practice.banks', [...bankSet].join(','));
    const allEntries = await this.loadAllPracticeEntries(app, sources);
    const entries = allEntries.filter(
      e => bankSet.has(e.bank) && isPracticable(e),
    );

    if (entries.length === 0) return null;

    // Fisher-Yates shuffle the candidate pool: ties (e.g. a batch of
    // brand-new cards, all equally due) surface in a different order every
    // pick instead of always the same first-in-file card. The most-overdue
    // card still wins — the shuffle only decides among equals.
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [entries[i], entries[j]] = [entries[j], entries[i]];
    }

    const history = await this.parseHistory(app, historyFilePath);

    const today = SpacedRepetition.getCurrentDayNumber();

    let nextEntry: PracticeEntry | null = null;
    let maxOverdue = -1;

    for (const entry of entries) {
      const reviews = this.reviewsForEntry(history, entry);
      const dueDay = SpacedRepetition.calculateDueDayNumber(reviews);

      if (dueDay <= today) {
        const overdue = today - dueDay;
        if (overdue > maxOverdue) {
          maxOverdue = overdue;
          nextEntry = entry;
        }
      }
    }

    // If nothing is strictly due, pick the one with the earliest due date (or a new entry)
    if (!nextEntry) {
      let earliestDue = Infinity;
      for (const entry of entries) {
        const reviews = this.reviewsForEntry(history, entry);
        const dueDay = SpacedRepetition.calculateDueDayNumber(reviews);
        if (dueDay < earliestDue) {
          earliestDue = dueDay;
          nextEntry = entry;
        }
      }
    }

    return nextEntry;
  }
}
