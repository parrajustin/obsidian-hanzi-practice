import {App} from 'obsidian';
import {
  FileUtil,
  FileSystemType,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {SpacedRepetition, Review} from '../spaced_repetition';
import {PracticeEntry, parsePracticeList} from './practice_list';

/**
 * History lines are keyed by the practice item's id (hash of
 * character+pinyin — see `computeEntryId`), because one character can be
 * practiced as several senses with different pinyin. The character and pinyin
 * are ALSO written on the line so a human reading the file can tell entries
 * apart without decoding the id:
 *
 *     - [<epoch-ms>] <id> 好 (hao3): 5
 *
 * The old format (`- [<epoch-ms>] 好: 5`) is still parsed; those reviews are
 * keyed by the bare character and attributed to every current sense of it.
 */
const HISTORY_LINE_REGEX = /- \[(\d+)\] ([0-9a-f]{8}) (\S+) \(([^)]*)\): (\d+)/;
const LEGACY_HISTORY_LINE_REGEX = /- \[(\d+)\] (.*?): (\d+)/;

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

  static async appendResult(
    app: App,
    historyFilePath: string,
    entry: PracticeEntry,
    score: number,
  ): Promise<void> {
    const timestamp = Date.now();
    const line = `\n- [${timestamp}] ${entry.id} ${entry.character} (${entry.pinyin}): ${score}`;

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
        score = parseInt(match[5]);
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
   * All reviews that apply to one practice entry: id-keyed reviews plus any
   * legacy character-keyed reviews (which predate per-sense ids), oldest
   * first — the order `SpacedRepetition.calculateDueDayNumber` expects.
   */
  static reviewsForEntry(
    history: Record<string, Review[]>,
    entry: PracticeEntry,
  ): Review[] {
    const reviews = [
      ...(history[entry.id] ?? []),
      ...(history[entry.character] ?? []),
    ];
    return reviews.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Average review score of one entry (0 when it has never been reviewed —
   * an unreviewed character counts as skill level 0).
   */
  static averageScore(reviews: Review[]): number {
    if (reviews.length === 0) return 0;
    return (
      reviews.reduce((sum, review) => sum + review.difficulty, 0) /
      reviews.length
    );
  }

  /**
   * "Mix up": a different character whose average spaced-repetition score is
   * within 0.5 of `current`'s, picked at random. Other senses of the same
   * character don't count as different. Null when no character qualifies.
   */
  static async getMixUpEntry(
    app: App,
    historyFilePath: string,
    practiceFilePath: string,
    current: PracticeEntry,
  ): Promise<PracticeEntry | null> {
    const allEntries = await this.loadPracticeEntries(app, practiceFilePath);
    const entries = allEntries.filter(e => e.character.length === 1);
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

  static async getNextDueEntry(
    app: App,
    historyFilePath: string,
    practiceFilePath: string,
  ): Promise<PracticeEntry | null> {
    const allEntries = await this.loadPracticeEntries(app, practiceFilePath);
    // Single hanzi only (matches how the app models practice items).
    const entries = allEntries.filter(e => e.character.length === 1);

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
