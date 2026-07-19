import {App} from 'obsidian';
import {
  FileUtil,
  FileSystemType,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {SpacedRepetition, Review} from '../spaced_repetition';
import {PracticeEntry, parsePracticeList} from './practice_list';

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

  /** Look up the cached entry (pinyin + english) for a single character. */
  static async getPracticeEntry(
    app: App,
    practiceFilePath: string,
    character: string,
  ): Promise<PracticeEntry | null> {
    const entries = await this.loadPracticeEntries(app, practiceFilePath);
    return entries.find(e => e.character === character) ?? null;
  }

  static async appendResult(
    app: App,
    historyFilePath: string,
    character: string,
    score: number,
  ): Promise<void> {
    const timestamp = Date.now();
    const line = `\n- [${timestamp}] ${character}: ${score}`;

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

    const regex = /- \[(\d+)\] (.*?): (\d+)/;
    for (const line of lines) {
      const match = line.match(regex);
      if (match) {
        const timestamp = parseInt(match[1]);
        const character = match[2].trim();
        const score = parseInt(match[3]);

        if (!history[character]) {
          history[character] = [];
        }
        history[character].push({timestamp, difficulty: score});
      }
    }

    return history;
  }

  static async getNextDueCharacter(
    app: App,
    historyFilePath: string,
    practiceFilePath: string,
  ): Promise<string | null> {
    const entries = await this.loadPracticeEntries(app, practiceFilePath);
    // Single hanzi only (matches how the app models practice items).
    const characters = entries
      .map(e => e.character)
      .filter(c => c.length === 1);

    if (characters.length === 0) return null;

    const history = await this.parseHistory(app, historyFilePath);

    const today = SpacedRepetition.getCurrentDayNumber();

    let nextChar = null;
    let maxOverdue = -1;

    for (const char of characters) {
      const reviews = history[char] || [];
      const dueDay = SpacedRepetition.calculateDueDayNumber(reviews);

      if (dueDay <= today) {
        const overdue = today - dueDay;
        if (overdue > maxOverdue) {
          maxOverdue = overdue;
          nextChar = char;
        }
      }
    }

    // If nothing is strictly due, pick the one with the earliest due date (or a new character)
    if (!nextChar) {
      let earliestDue = Infinity;
      for (const char of characters) {
        const reviews = history[char] || [];
        const dueDay = SpacedRepetition.calculateDueDayNumber(reviews);
        if (dueDay < earliestDue) {
          earliestDue = dueDay;
          nextChar = char;
        }
      }
    }

    return nextChar;
  }
}
