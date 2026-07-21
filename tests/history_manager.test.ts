import {HistoryManager} from '../src/utils/history_manager';
import {computeEntryId} from '../src/utils/practice_list';
import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Ok} from 'standard-ts-lib/src/result';
import {TextEncoder, TextDecoder} from 'util';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

// Mock FileUtil
jest.mock('standard-obsidian-lib/src/filesystem/file_util');

const HAN_ID = computeEntryId('汉', 'han4');
const YU_ID = computeEntryId('语', 'yu3');
const HAO3_ID = computeEntryId('好', 'hao3');
const HAO4_ID = computeEntryId('好', 'hao4');

describe('HistoryManager', () => {
  let mockApp: App;

  beforeEach(() => {
    mockApp = new App();
    jest.clearAllMocks();
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-07-19T12:00:00Z').getTime());
  });

  it('should parse id-keyed history lines', async () => {
    const mockHistory = `
- [1718712000000] ${HAN_ID} 汉 (han4): 4
- [1718798400000] ${YU_ID} 语 (yu3): 3
- [1718798400000] ${HAN_ID} 汉 (han4): 5
`;
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new TextEncoder().encode(mockHistory)),
    );

    const history = await HistoryManager.parseHistory(mockApp, 'history.md');

    expect(history[HAN_ID]).toBeDefined();
    expect(history[HAN_ID].length).toBe(2);
    expect(history[HAN_ID][0].difficulty).toBe(4);
    expect(history[HAN_ID][1].difficulty).toBe(5);

    expect(history[YU_ID]).toBeDefined();
    expect(history[YU_ID].length).toBe(1);
    expect(history[YU_ID][0].difficulty).toBe(3);
  });

  it('should parse legacy character-keyed history lines', async () => {
    const mockHistory = `
- [1718712000000] 汉: 4
- [1718798400000] 语: 3
`;
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new TextEncoder().encode(mockHistory)),
    );

    const history = await HistoryManager.parseHistory(mockApp, 'history.md');

    expect(history['汉'].length).toBe(1);
    expect(history['汉'][0].difficulty).toBe(4);
    expect(history['语'][0].difficulty).toBe(3);
  });

  it('reviewsForEntry merges id-keyed and legacy reviews, oldest first', () => {
    const history = {
      [HAO3_ID]: [{timestamp: 300, difficulty: 5}],
      好: [{timestamp: 100, difficulty: 3}],
    };
    const reviews = HistoryManager.reviewsForEntry(history, {
      id: HAO3_ID,
      character: '好',
      pinyin: 'hao3',
      english: 'good',
    });
    expect(reviews.map(r => r.timestamp)).toEqual([100, 300]);
  });

  it('appendResult writes the id AND the human-readable char/pinyin', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(Ok(new Uint8Array(0)));
    let written = '';
    (FileUtil.writeToFile as jest.Mock).mockImplementation(
      (_app: App, _path: string, data: Uint8Array) => {
        written = new TextDecoder().decode(data);
        return Promise.resolve(Ok(undefined));
      },
    );

    await HistoryManager.appendResult(
      mockApp,
      'history.md',
      {id: HAO3_ID, character: '好', pinyin: 'hao3', english: 'good'},
      5,
    );

    expect(written).toContain(`${HAO3_ID} 好 (hao3): 5`);
    // And the line it writes must parse back to the same id.
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new TextEncoder().encode(written)),
    );
    const history = await HistoryManager.parseHistory(mockApp, 'history.md');
    expect(history[HAO3_ID].length).toBe(1);
  });

  it('should calculate next due entry', async () => {
    const mockPracticeList =
      '汉\than4\tChinese\n语\tyu3\tlanguage\n测\tce4\ttest\n试\tshi4\texam';

    // "汉" is overdue (last reviewed safely but early)
    // "语" has no history (brand new) -> gets scheduled for today - 1 (very overdue)
    // "测" recently reviewed perfectly -> due later

    const mockHistory = `
- [1618712000000] ${HAN_ID} 汉 (han4): 3
- [1718798400000] ${computeEntryId('测', 'ce4')} 测 (ce4): 5
`;

    // fetchFile is called twice: once for practice file, once for history file
    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockPracticeList)))
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockHistory)));

    const nextEntry = await HistoryManager.getNextDueEntry(
      mockApp,
      'history.md',
      'practice.md',
    );

    // "语" and "试" have no reviews, meaning SpacedRepetition gives them today - 1.
    // "汉" is very old, due extremely far in the past.
    // The most overdue should be picked.

    expect(nextEntry?.character).toBe('汉');
    expect(nextEntry?.id).toBe(HAN_ID);
  });

  it('schedules senses of the same character independently', async () => {
    const mockPracticeList = [
      `好\thao3\tgood\t${HAO3_ID}`,
      `好\thao4\tto be fond of\t${HAO4_ID}`,
    ].join('\n');

    // hao3 was just reviewed perfectly twice -> due in the future.
    // hao4 has no reviews -> due yesterday (brand new), so it must be picked
    // even though both entries are the same character.
    const now = new Date('2026-07-19T12:00:00Z').getTime();
    const mockHistory = `
- [${now - 2 * 86400000}] ${HAO3_ID} 好 (hao3): 5
- [${now - 86400000}] ${HAO3_ID} 好 (hao3): 5
`;

    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockPracticeList)))
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockHistory)));

    const nextEntry = await HistoryManager.getNextDueEntry(
      mockApp,
      'history.md',
      'practice.md',
    );

    expect(nextEntry?.id).toBe(HAO4_ID);
    expect(nextEntry?.pinyin).toBe('hao4');
  });

  it('averageScore is 0 for unreviewed entries and the mean otherwise', () => {
    expect(HistoryManager.averageScore([])).toBe(0);
    expect(
      HistoryManager.averageScore([
        {timestamp: 1, difficulty: 5},
        {timestamp: 2, difficulty: 2},
      ]),
    ).toBe(3.5);
  });

  it('getMixUpEntry picks a different character within 0.5 average score', async () => {
    const mockPracticeList = [
      `好\thao3\tgood\t${HAO3_ID}`,
      '汉\than4\tChinese',
      '语\tyu3\tlanguage',
    ].join('\n');

    // 好 avg 4.5; 汉 avg 4.0 (within 0.5); 语 unreviewed avg 0 (excluded).
    const mockHistory = `
- [1718712000000] ${HAO3_ID} 好 (hao3): 4
- [1718798400000] ${HAO3_ID} 好 (hao3): 5
- [1718798400000] ${HAN_ID} 汉 (han4): 4
`;

    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockPracticeList)))
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockHistory)));

    const mixUp = await HistoryManager.getMixUpEntry(
      mockApp,
      'history.md',
      'practice.md',
      {id: HAO3_ID, character: '好', pinyin: 'hao3', english: 'good'},
    );

    expect(mixUp?.character).toBe('汉');
  });

  it('getMixUpEntry never returns another sense of the same character', async () => {
    const mockPracticeList = [
      `好\thao3\tgood\t${HAO3_ID}`,
      `好\thao4\tto be fond of\t${HAO4_ID}`,
    ].join('\n');
    // Both senses are unreviewed (avg 0) — same character, so no candidate.
    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockPracticeList)))
      .mockResolvedValueOnce(Ok(new TextEncoder().encode('')));

    const mixUp = await HistoryManager.getMixUpEntry(
      mockApp,
      'history.md',
      'practice.md',
      {id: HAO3_ID, character: '好', pinyin: 'hao3', english: 'good'},
    );

    expect(mixUp).toBeNull();
  });

  it('getMixUpEntry returns null when no character is within 0.5', async () => {
    const mockPracticeList = [
      `好\thao3\tgood\t${HAO3_ID}`,
      '汉\than4\tChinese',
    ].join('\n');

    // 好 avg 5; 汉 unreviewed avg 0 — outside the 0.5 window.
    const mockHistory = `
- [1718798400000] ${HAO3_ID} 好 (hao3): 5
`;

    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockPracticeList)))
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockHistory)));

    const mixUp = await HistoryManager.getMixUpEntry(
      mockApp,
      'history.md',
      'practice.md',
      {id: HAO3_ID, character: '好', pinyin: 'hao3', english: 'good'},
    );

    expect(mixUp).toBeNull();
  });

  it('attributes legacy character-keyed reviews to current senses', async () => {
    const mockPracticeList = [
      `好\thao3\tgood\t${HAO3_ID}`,
      '汉\than4\tChinese',
    ].join('\n');

    // Legacy history (no ids): 好 reviewed long ago, 汉 reviewed recently and
    // perfectly (twice, so it is due days later). 好 is the more overdue one —
    // but only if its legacy review is attributed to the hao3 entry (a lone
    // legacy review with difficulty 5 schedules +1 day; unreviewed would be
    // due yesterday, i.e. LESS overdue than 好's ancient review).
    const mockHistory = `
- [1618712000000] 好: 3
- [1718712000000] 汉: 5
- [1718798400000] 汉: 5
`;

    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockPracticeList)))
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockHistory)));

    const nextEntry = await HistoryManager.getNextDueEntry(
      mockApp,
      'history.md',
      'practice.md',
    );

    expect(nextEntry?.id).toBe(HAO3_ID);
  });
});
