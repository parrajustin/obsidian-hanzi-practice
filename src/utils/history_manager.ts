import {App} from 'obsidian';
import {
  FileUtil,
  FileSystemType,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {SpacedRepetition, Review} from '../spaced_repetition';
import {
  BankSource,
  CardType,
  entryLabel,
  HANZI_BANK,
  HanziEntry,
  IsFlashcardEntry,
  PracticeEntry,
  parsePracticeList,
} from './practice_list';

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
  // The drawing quiz models exactly one hanzi at a time.
  return entry.character.length === 1;
}

export class HistoryManager {
  /** Load and parse the practice list into structured entries. */
  static async loadPracticeEntries(
    app: App,
    practiceFilePath: string,
  ): Promise<PracticeEntry[]> {
    const practiceResult = await FileUtil.fetchFile(
      app,
      practiceFilePath,
      FileSystemType.OBSIDIAN,
    );
    if (!practiceResult.ok) {
      return [];
    }
    const text = new TextDecoder('utf-8').decode(practiceResult.val);
    return parsePracticeList(text);
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

  static async appendResult(
    app: App,
    historyFilePath: string,
    entry: PracticeEntry,
    score: number,
  ): Promise<void> {
    const timestamp = Date.now();
    const line = `\n- [${timestamp}] ${entry.id} ${entryLabel(entry)}: ${score}`;

    const fileResult = await FileUtil.fetchFile(
      app,
      historyFilePath,
      FileSystemType.OBSIDIAN,
    );
    let currentData: Uint8Array = new Uint8Array(0);
    if (fileResult.ok) {
      currentData = fileResult.val;
    }

    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(currentData);
    const newText = text + line;

    const encoder = new TextEncoder();
    await FileUtil.writeToFile(
      app,
      historyFilePath,
      encoder.encode(newText),
      FileSystemType.OBSIDIAN,
    );
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
    const text = decoder.decode(fileResult.val);
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
    const legacy = IsFlashcardEntry(entry)
      ? []
      : (history[entry.character] ?? []);
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
    if (IsFlashcardEntry(current)) return null;
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
  static async getNextDueEntry(
    app: App,
    historyFilePath: string,
    sources: BankSource[],
    bank: string,
  ): Promise<PracticeEntry | null> {
    const allEntries = await this.loadAllPracticeEntries(app, sources);
    const entries = allEntries.filter(e => e.bank === bank && isPracticable(e));

    if (entries.length === 0) return null;

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
