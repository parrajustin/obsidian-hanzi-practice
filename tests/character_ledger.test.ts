/**
 * The generated character ledger: which characters get tracked, what survives
 * a re-sync, and the file it produces (a progress table a human reads, plus
 * card lines the plugin practices).
 */

import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Err, Ok} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {TextEncoder, TextDecoder} from 'util';
import {
  CardTextForCharacters,
  CharactersInCard,
  LoadCharacterIndex,
  LoadLedgerEntries,
  SyncCharacterLedger,
} from '../src/utils/character_ledger';
import {ProgressFor} from '../src/character_progress';
import {CedictParser} from '../src/dictionary/cedict_parser';
import {
  CardType,
  CHARACTER_BANK,
  computeEntryId,
  HanziEntry,
  PracticeEntry,
  parsePracticeList,
} from '../src/utils/practice_list';
import {Review} from '../src/spaced_repetition';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as never;

jest.mock('standard-obsidian-lib/src/filesystem/file_util');

const app = new App();

/** A dictionary with just the senses these tests need. */
function fakeDictionary(
  senses: Record<string, {pinyin: string; english: string}>,
): CedictParser {
  const payload = (char: string) => {
    const sense = senses[char];
    return sense
      ? [
          JSON.stringify({
            simplified: char,
            traditional: char,
            pinyin: sense.pinyin,
            english: sense.english,
          }),
        ]
      : null;
  };
  return {
    simplifiedTrie: {search: payload},
    traditionalTrie: {search: () => null},
  } as unknown as CedictParser;
}

const flashcard = (front: string, back: string): PracticeEntry => ({
  id: 'aaaaaaaa',
  cardType: CardType.FLASHCARD,
  bank: 'L2 Words',
  front,
  back,
});

/** Capture what SyncCharacterLedger writes. */
function captureWrites(): {text: () => string} {
  let written = '';
  (FileUtil.writeToFile as jest.Mock).mockImplementation(
    (_app: unknown, _path: string, data: Uint8Array) => {
      written = new TextDecoder().decode(data);
      return Promise.resolve(Ok(undefined));
    },
  );
  return {text: () => written};
}

beforeEach(() => {
  jest.clearAllMocks();
  (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
    Err(NotFoundError('no ledger yet')),
  );
});

describe('which characters a card contributes', () => {
  it('takes them from every side of the card, answers included', () => {
    expect(CardTextForCharacters(flashcard('开车', 'to drive'))).toContain(
      '开车',
    );
    expect(
      CharactersInCard({
        id: 'b',
        cardType: CardType.MULTIPLE_CHOICE,
        bank: 'Grammar',
        question: '你__狗吗？',
        answer: '有没有',
        distractors: ['不有'],
      }),
    ).toEqual(['你', '狗', '吗', '有', '没', '不']);
  });

  it('ignores punctuation and latin', () => {
    expect(CharactersInCard(flashcard('车 (car)', 'bus，really'))).toEqual([
      '车',
    ]);
  });
});

describe('SyncCharacterLedger', () => {
  it('writes one card line per character, with its dictionary reading', async () => {
    const written = captureWrites();
    const result = await SyncCharacterLedger(
      app,
      'chars.md',
      [flashcard('开车', 'to drive (a car)')],
      fakeDictionary({
        开: {pinyin: 'kai1', english: 'to open/to drive'},
        车: {pinyin: 'che1', english: 'car/vehicle'},
      }),
      entry => ProgressFor(entry.character, []),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val).toMatchObject({total: 2, added: 2, unknown: []});

    const entries = parsePracticeList(written.text()) as HanziEntry[];
    expect(entries.map(e => e.character)).toEqual(['开', '车']);
    expect(entries[0]).toMatchObject({
      character: '开',
      pinyin: 'kai1',
      bank: CHARACTER_BANK,
      cardType: CardType.HANZI,
      id: computeEntryId('开', 'kai1'),
    });
  });

  it('opens the file with a human-readable progress table', async () => {
    const written = captureWrites();
    await SyncCharacterLedger(
      app,
      'chars.md',
      [flashcard('好', 'good')],
      fakeDictionary({好: {pinyin: 'hao3', english: 'good/well'}}),
      entry =>
        ProgressFor(entry.character, [
          {timestamp: 1, difficulty: 5},
          {timestamp: 2, difficulty: 4},
          {timestamp: 3, difficulty: 5},
        ]),
    );
    const text = written.text();
    expect(text).toContain('# Character progress');
    expect(text).toContain('| Character | Pinyin | Meaning | Level |');
    // Pretty pinyin for humans, level from the injected history.
    expect(text).toContain('| 好 | hǎo |');
    expect(text).toMatch(/\| 好 \| hǎo \| good \| 5 \| 3 \| 4\.7 \|/);
    // ...and the table is NOT parsed back as cards.
    expect(parsePracticeList(text)).toHaveLength(1);
  });

  it('tracks a character with no dictionary sense, and reports it', async () => {
    const written = captureWrites();
    const result = await SyncCharacterLedger(
      app,
      'chars.md',
      [flashcard('好〇', 'odd')],
      fakeDictionary({好: {pinyin: 'hao3', english: 'good'}}),
      entry => ProgressFor(entry.character, []),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 〇 is not in the hanzi ranges we track, so only 好 is a character here;
    // an unknown-but-tracked character is the case below.
    expect(result.val.total).toBe(1);
    expect(written.text()).toContain('好');
  });

  it("teaches the primary reading, not CEDICT's first sense", async () => {
    const written = captureWrites();
    // The real dictionary lists 车's surname sense first.
    const multiSense = {
      simplifiedTrie: {
        search: (char: string) =>
          char === '车'
            ? [
                JSON.stringify({
                  simplified: '车',
                  traditional: '車',
                  pinyin: 'Che1',
                  english: 'surname Che',
                }),
                JSON.stringify({
                  simplified: '车',
                  traditional: '車',
                  pinyin: 'che1',
                  english: 'car/vehicle',
                }),
              ]
            : null,
      },
      traditionalTrie: {search: () => null},
    } as unknown as CedictParser;

    await SyncCharacterLedger(
      app,
      'chars.md',
      [flashcard('车', 'car')],
      multiSense,
      entry => ProgressFor(entry.character, []),
    );
    const [entry] = parsePracticeList(written.text()) as HanziEntry[];
    expect(entry).toMatchObject({pinyin: 'che1', english: 'car/vehicle'});
  });

  it('reports characters the dictionary has never heard of', async () => {
    captureWrites();
    const result = await SyncCharacterLedger(
      app,
      'chars.md',
      [flashcard('龘', 'a rare one')],
      fakeDictionary({}),
      entry => ProgressFor(entry.character, []),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.unknown).toEqual(['龘']);
    expect(result.val.total).toBe(1);
  });

  it('KEEPS existing lines — a re-sync must not orphan review history', async () => {
    const existingId = 'deadbeef';
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(
        new TextEncoder().encode(
          `车\tche1\tcar (edited by hand)\t${existingId}\t0\t${CHARACTER_BANK}`,
        ),
      ),
    );
    const written = captureWrites();
    await SyncCharacterLedger(
      app,
      'chars.md',
      [flashcard('开车', 'to drive')],
      fakeDictionary({
        开: {pinyin: 'kai1', english: 'to open'},
        车: {pinyin: 'XXXX', english: 'REPLACED'},
      }),
      entry => ProgressFor(entry.character, []),
    );
    const entries = parsePracticeList(written.text()) as HanziEntry[];
    const che = entries.find(e => e.character === '车');
    // The id is what history is keyed by, and the hand-edited definition is
    // the user's: neither may be overwritten by a re-sync.
    expect(che).toMatchObject({
      id: existingId,
      pinyin: 'che1',
      english: 'car (edited by hand)',
    });
  });

  it('keeps characters whose cards were deleted, never dropping history', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(
        new TextEncoder().encode(
          `旧\tjiu4\told\tcafebabe\t0\t${CHARACTER_BANK}`,
        ),
      ),
    );
    const written = captureWrites();
    const result = await SyncCharacterLedger(
      app,
      'chars.md',
      [flashcard('好', 'good')],
      fakeDictionary({好: {pinyin: 'hao3', english: 'good'}}),
      entry => ProgressFor(entry.character, []),
    );
    expect(result.ok).toBe(true);
    const characters = (parsePracticeList(written.text()) as HanziEntry[]).map(
      e => e.character,
    );
    expect(characters).toEqual(['好', '旧']);
  });

  it('does not seed itself from its own bank', async () => {
    const written = captureWrites();
    const result = await SyncCharacterLedger(
      app,
      'chars.md',
      [
        {
          id: 'x',
          cardType: CardType.HANZI,
          bank: CHARACTER_BANK,
          character: '旧',
          pinyin: 'jiu4',
          english: 'old',
        },
      ],
      fakeDictionary({}),
      entry => ProgressFor(entry.character, []),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.val.total).toBe(0);
    expect(written.text()).not.toContain('旧\tjiu4');
  });

  it('surfaces a write failure instead of reporting success', async () => {
    (FileUtil.writeToFile as jest.Mock).mockResolvedValue(
      Err(NotFoundError('read-only vault')),
    );
    const result = await SyncCharacterLedger(
      app,
      'chars.md',
      [flashcard('好', 'good')],
      fakeDictionary({好: {pinyin: 'hao3', english: 'good'}}),
      entry => ProgressFor(entry.character, []),
    );
    expect(result.ok).toBe(false);
  });
});

describe('LoadCharacterIndex', () => {
  const ledger = `好\thao3\tgood/well\tid-hao\t0\t${CHARACTER_BANK}\n车\tche1\tcar\tid-che\t0\t${CHARACTER_BANK}`;

  beforeEach(() => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new TextEncoder().encode(ledger)),
    );
  });

  it('exposes the reading, the pretty form and the level per character', async () => {
    const reviews: Record<string, Review[]> = {
      'id-hao': [
        {timestamp: 1, difficulty: 5},
        {timestamp: 2, difficulty: 5},
        {timestamp: 3, difficulty: 5},
      ],
    };
    const index = await LoadCharacterIndex(
      app,
      'chars.md',
      entry => reviews[entry.id] ?? [],
    );
    expect(index.get('好')).toMatchObject({
      pinyin: 'hao3',
      prettyPinyin: 'hǎo',
      level: 5,
      reviewCount: 3,
      id: 'id-hao',
    });
    // Never practiced: level 0, so its reading still prints.
    expect(index.get('车')).toMatchObject({level: 0, reviewCount: 0});
  });

  it('is empty when the ledger does not exist yet', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Err(NotFoundError('no file')),
    );
    expect((await LoadCharacterIndex(app, 'chars.md', () => [])).size).toBe(0);
    expect(await LoadLedgerEntries(app, 'chars.md')).toEqual([]);
  });
});
