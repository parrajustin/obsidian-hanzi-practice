/**
 * Load/save round-trips of every card type through the markdown line format
 * documented in CARD_FORMATS.md: entry → formatPracticeEntry → markdown →
 * parsePracticeList → identical entry, plus loading whole bank files from
 * the vault via HistoryManager. practice_list.test.ts covers the parser's
 * edge cases; this suite pins the documented format per card type.
 */
import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Ok} from 'standard-ts-lib/src/result';
import {TextEncoder, TextDecoder} from 'util';
import {
  CardType,
  ClozeEntry,
  computeClozeId,
  computeEntryId,
  computeFlashcardId,
  computeMultiChoiceId,
  computeTrueFalseId,
  FlashcardEntry,
  formatPracticeEntry,
  HANZI_BANK,
  HanziEntry,
  MultiChoiceEntry,
  parsePracticeList,
  PracticeEntry,
  TrueFalseEntry,
} from '../src/utils/practice_list';
import {HistoryManager} from '../src/utils/history_manager';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

jest.mock('standard-obsidian-lib/src/filesystem/file_util');

/** One entry of each card type, as they would live in real bank files. */
const HANZI: HanziEntry = {
  id: computeEntryId('好', 'hao3'),
  cardType: CardType.HANZI,
  bank: HANZI_BANK,
  character: '好',
  pinyin: 'hao3',
  english: 'good/appropriate',
};

const FLASHCARD: FlashcardEntry = {
  id: computeFlashcardId('Capitals', 'France', 'Paris'),
  cardType: CardType.FLASHCARD,
  bank: 'Capitals',
  front: 'France',
  back: 'Paris',
};

const REVERSIBLE: FlashcardEntry = {
  id: computeFlashcardId('German', 'dog', 'Hund'),
  cardType: CardType.REVERSIBLE_FLASHCARD,
  bank: 'German',
  front: 'dog',
  back: 'Hund',
};

const MULTI_CHOICE: MultiChoiceEntry = {
  id: computeMultiChoiceId('Grammar', '你__狗吗？', '有没有'),
  cardType: CardType.MULTIPLE_CHOICE,
  bank: 'Grammar',
  question: '你__狗吗？',
  answer: '有没有',
  distractors: ['不有', '没不有'],
};

const CLOZE: ClozeEntry = {
  id: computeClozeId('German', '我一个星期{{没}}吃饭。'),
  cardType: CardType.CLOZE,
  bank: 'German',
  text: '我一个星期{{没}}吃饭。',
  hint: "I haven't eaten for a week.",
};

const TRUE_FALSE: TrueFalseEntry = {
  id: computeTrueFalseId('Grammar', '你有没有一只狗吗？'),
  cardType: CardType.TRUE_FALSE,
  bank: 'Grammar',
  statement: '你有没有一只狗吗？',
  isCorrect: false,
  explanation: '有没有 already forms the question — drop the 吗.',
};

const ALL_ENTRIES: PracticeEntry[] = [
  HANZI,
  FLASHCARD,
  REVERSIBLE,
  MULTI_CHOICE,
  CLOZE,
  TRUE_FALSE,
];

/** Serialize entries the way the plugin writes a bank file. */
function toMarkdown(entries: PracticeEntry[]): string {
  return entries.map(formatPracticeEntry).join('\n') + '\n';
}

function mockVaultFile(text: string) {
  (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
    Ok(new TextEncoder().encode(text)),
  );
}

describe('per-card-type markdown lines (the documented format)', () => {
  it('saves a hanzi card as char⇥pinyin⇥english⇥id⇥0⇥bank', () => {
    expect(formatPracticeEntry(HANZI)).toBe(
      '好\thao3\tgood/appropriate\t70b6d1dc\t0\tHanzi',
    );
  });

  it('saves a flashcard as front⇥back⇥⇥id⇥1⇥bank', () => {
    expect(formatPracticeEntry(FLASHCARD)).toBe(
      `France\tParis\t\t${FLASHCARD.id}\t1\tCapitals`,
    );
  });

  it('saves a reversible flashcard with card type 2', () => {
    expect(formatPracticeEntry(REVERSIBLE)).toBe(
      `dog\tHund\t\t${REVERSIBLE.id}\t2\tGerman`,
    );
  });

  it('saves a multiple-choice card as question⇥answer⇥distractors⇥id⇥3⇥bank', () => {
    expect(formatPracticeEntry(MULTI_CHOICE)).toBe(
      `你__狗吗？\t有没有\t不有|没不有\t${MULTI_CHOICE.id}\t3\tGrammar`,
    );
  });

  it('saves a cloze card as text⇥hint⇥⇥id⇥4⇥bank', () => {
    expect(formatPracticeEntry(CLOZE)).toBe(
      `我一个星期{{没}}吃饭。\tI haven't eaten for a week.\t\t${CLOZE.id}\t4\tGerman`,
    );
  });

  it('saves a true/false card as statement⇥true|false⇥explanation⇥id⇥5⇥bank', () => {
    expect(formatPracticeEntry(TRUE_FALSE)).toBe(
      `你有没有一只狗吗？\tfalse\t有没有 already forms the question — drop the 吗.\t${TRUE_FALSE.id}\t5\tGrammar`,
    );
  });

  it.each(ALL_ENTRIES.map(entry => [CardType[entry.cardType], entry]))(
    'round-trips a %s card save → load without loss',
    (_name, entry) => {
      const [loaded] = parsePracticeList(formatPracticeEntry(entry));
      expect(loaded).toEqual(entry);
    },
  );
});

describe('whole-file markdown round-trip', () => {
  it('a mixed-type file loads to the same entries and re-saves identically', () => {
    const markdown = toMarkdown(ALL_ENTRIES);
    const loaded = parsePracticeList(markdown);
    expect(loaded).toEqual(ALL_ENTRIES);
    expect(toMarkdown(loaded)).toBe(markdown);
  });

  it('loading derives ids for id-less lines, then saves them stably', () => {
    const withoutIds = ALL_ENTRIES.map(entry => {
      const [f0, f1, f2, , cardType, bank] =
        formatPracticeEntry(entry).split('\t');
      return [f0, f1, f2, '', cardType, bank].join('\t');
    }).join('\n');
    const loaded = parsePracticeList(withoutIds);
    expect(loaded).toEqual(ALL_ENTRIES);
    // A second round-trip must be byte-stable (ids never re-derive
    // differently) or every save would rewrite the whole file.
    expect(parsePracticeList(toMarkdown(loaded))).toEqual(loaded);
  });
});

describe('loading bank files from the vault', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(ALL_ENTRIES.map(entry => [CardType[entry.cardType], entry]))(
    'loads a bank file holding a %s card',
    async (_name, entry) => {
      mockVaultFile(formatPracticeEntry(entry) + '\n');
      const entries = await HistoryManager.loadPracticeEntries(
        new App(),
        'bank.md',
      );
      expect(entries).toEqual([entry]);
    },
  );

  it('the file a card lives in decides its bank (except the Hanzi file)', async () => {
    // The German file holds a line tagged "Capitals" — the file wins.
    const mislabeled = formatPracticeEntry({...CLOZE, bank: 'Capitals'});
    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(toMarkdown([HANZI]))))
      .mockResolvedValueOnce(Ok(new TextEncoder().encode(mislabeled)));
    const entries = await HistoryManager.loadAllPracticeEntries(new App(), [
      {name: HANZI_BANK, filePath: 'hanzi-practice-words.md'},
      {name: 'German', filePath: 'german-cards.md'},
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(HANZI);
    expect(entries[1].bank).toBe('German');
  });

  it('legacy bank tags inside the Hanzi file are preserved', async () => {
    // Pre-per-bank-file vaults stored every bank's cards in the hanzi file.
    mockVaultFile(toMarkdown([HANZI, FLASHCARD]));
    const entries = await HistoryManager.loadAllPracticeEntries(new App(), [
      {name: HANZI_BANK, filePath: 'hanzi-practice-words.md'},
    ]);
    expect(entries).toEqual([HANZI, FLASHCARD]);
  });
});
