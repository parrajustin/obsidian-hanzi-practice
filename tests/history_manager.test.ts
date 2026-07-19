import {HistoryManager} from '../src/utils/history_manager';
import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Ok} from 'standard-ts-lib/src/result';
import {TextEncoder, TextDecoder} from 'util';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

// Mock FileUtil
jest.mock('standard-obsidian-lib/src/filesystem/file_util');

describe('HistoryManager', () => {
  let mockApp: App;

  beforeEach(() => {
    mockApp = new App();
    jest.clearAllMocks();
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-07-19T12:00:00Z').getTime());
  });

  it('should parse history correctly', async () => {
    const mockHistory = `
- [1718712000000] 汉: 4
- [1718798400000] 语: 3
- [1718798400000] 汉: 5
`;
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new TextEncoder().encode(mockHistory)),
    );

    const history = await HistoryManager.parseHistory(mockApp, 'history.md');

    expect(history['汉']).toBeDefined();
    expect(history['汉'].length).toBe(2);
    expect(history['汉'][0].difficulty).toBe(4);
    expect(history['汉'][1].difficulty).toBe(5);

    expect(history['语']).toBeDefined();
    expect(history['语'].length).toBe(1);
    expect(history['语'][0].difficulty).toBe(3);
  });

  it('should calculate next due character', async () => {
    const mockPracticeList = '汉\n语\n测\n试';

    // "汉" is overdue (last reviewed safely but early)
    // "语" has no history (brand new) -> gets scheduled for today - 1 (very overdue)
    // "测" recently reviewed perfectly -> due later

    const mockHistory = `
- [1618712000000] 汉: 3
- [1718798400000] 测: 5
`;

    // fetchFile is called twice: once for practice file, once for history file
    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockPracticeList)))
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mockHistory)));

    const nextChar = await HistoryManager.getNextDueCharacter(
      mockApp,
      'history.md',
      'practice.md',
    );

    // "语" and "试" have no reviews, meaning SpacedRepetition gives them today - 1.
    // "汉" is very old, due extremely far in the past.
    // The most overdue should be picked.

    expect(nextChar).toBe('汉');
  });
});
