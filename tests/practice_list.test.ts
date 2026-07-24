import {
  CardType,
  computeClozeId,
  computeEntryId,
  computeFlashcardId,
  computeMultiChoiceId,
  entryLabel,
  formatPracticeEntry,
  HANZI_BANK,
  listBanks,
  parseClozeSegments,
  parsePracticeList,
  sanitizeField,
  sanitizeOption,
} from '../src/utils/practice_list';

describe('computeEntryId', () => {
  it('is deterministic and 8 hex chars', () => {
    const id = computeEntryId('好', 'hao3');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(computeEntryId('好', 'hao3')).toBe(id);
  });

  it('distinguishes senses of the same character', () => {
    expect(computeEntryId('好', 'hao3')).not.toBe(computeEntryId('好', 'hao4'));
    expect(computeEntryId('好', 'hao3')).not.toBe(computeEntryId('汉', 'hao3'));
  });

  it('matches the historical char+pinyin hash (ids must never change)', () => {
    // Golden value from the pre-card-type implementation: FNV-1a over
    // "好hao3". Existing vaults key their history by these ids.
    expect(computeEntryId('好', 'hao3')).toBe('70b6d1dc');
  });
});

describe('computeFlashcardId', () => {
  it('includes the bank, so the same card can live in two banks', () => {
    const a = computeFlashcardId('Capitals', 'France', 'Paris');
    const b = computeFlashcardId('Europe', 'France', 'Paris');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('parsePracticeList', () => {
  it('parses 4-field hanzi lines, keeping the stored id', () => {
    const entries = parsePracticeList('好\thao3\tgood/proper\tdeadbeef');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: 'deadbeef',
      cardType: CardType.HANZI,
      bank: HANZI_BANK,
      character: '好',
      pinyin: 'hao3',
      english: 'good/proper',
    });
  });

  it('derives the id for older 3-field lines', () => {
    const entries = parsePracticeList('好\thao3\tgood/proper');
    expect(entries[0].id).toBe(computeEntryId('好', 'hao3'));
  });

  it('still accepts plain one-char lines (oldest format)', () => {
    const entries = parsePracticeList('汉\n好\thao3\tgood');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: computeEntryId('汉', ''),
      cardType: CardType.HANZI,
      bank: HANZI_BANK,
      character: '汉',
      pinyin: '',
      english: '',
    });
  });

  it('keeps two senses of the same character as separate entries', () => {
    const entries = parsePracticeList(
      '好\thao3\tgood\n好\thao4\tto be fond of',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].id).not.toBe(entries[1].id);
  });

  it('parses 6-field flashcard lines with card type and bank', () => {
    const entries = parsePracticeList('France\tParis\t\tdeadbeef\t1\tCapitals');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: 'deadbeef',
      cardType: CardType.FLASHCARD,
      bank: 'Capitals',
      front: 'France',
      back: 'Paris',
    });
  });

  it('parses reversible flashcards', () => {
    const entries = parsePracticeList('France\tParis\t\tdeadbeef\t2\tCapitals');
    expect(entries[0].cardType).toBe(CardType.REVERSIBLE_FLASHCARD);
  });

  it('treats an unknown card type as a hanzi card instead of dropping it', () => {
    const entries = parsePracticeList('好\thao3\tgood\tdeadbeef\t9\tHanzi');
    expect(entries).toHaveLength(1);
    expect(entries[0].cardType).toBe(CardType.HANZI);
  });

  it('parses multiple-choice lines, splitting distractors on |', () => {
    const entries = parsePracticeList(
      '你__狗吗？\t有没有\t不有|没不有\tdeadbeef\t3\tGrammar',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: 'deadbeef',
      cardType: CardType.MULTIPLE_CHOICE,
      bank: 'Grammar',
      question: '你__狗吗？',
      answer: '有没有',
      distractors: ['不有', '没不有'],
    });
  });

  it('parses a multiple-choice line with an empty distractor field', () => {
    const entries = parsePracticeList('Q\tA\t\tdeadbeef\t3\tGrammar');
    expect(entries[0]).toMatchObject({
      cardType: CardType.MULTIPLE_CHOICE,
      distractors: [],
    });
  });

  it('parses cloze lines with text and hint', () => {
    const entries = parsePracticeList(
      "我一个星期{{没}}吃饭。\tI haven't eaten for a week.\t\tdeadbeef\t4\tCloze",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: 'deadbeef',
      cardType: CardType.CLOZE,
      bank: 'Cloze',
      text: '我一个星期{{没}}吃饭。',
      hint: "I haven't eaten for a week.",
    });
  });
});

describe('formatPracticeEntry', () => {
  it('writes hanzi cards as 6 tab-separated fields', () => {
    const line = formatPracticeEntry({
      id: 'deadbeef',
      cardType: CardType.HANZI,
      bank: HANZI_BANK,
      character: '好',
      pinyin: 'hao3',
      english: 'good',
    });
    expect(line).toBe('好\thao3\tgood\tdeadbeef\t0\tHanzi');
  });

  it('derives a missing id, and round-trips through parse', () => {
    const line = formatPracticeEntry({
      id: '',
      cardType: CardType.HANZI,
      bank: HANZI_BANK,
      character: '好',
      pinyin: 'hao4',
      english: 'to be fond of',
    });
    const [entry] = parsePracticeList(line);
    expect(entry.id).toBe(computeEntryId('好', 'hao4'));
    expect(formatPracticeEntry(entry)).toBe(line);
  });

  it('round-trips flashcards through parse', () => {
    const line = formatPracticeEntry({
      id: '',
      cardType: CardType.REVERSIBLE_FLASHCARD,
      bank: 'Capitals',
      front: 'France',
      back: 'Paris',
    });
    const [entry] = parsePracticeList(line);
    expect(entry).toEqual({
      id: computeFlashcardId('Capitals', 'France', 'Paris'),
      cardType: CardType.REVERSIBLE_FLASHCARD,
      bank: 'Capitals',
      front: 'France',
      back: 'Paris',
    });
    expect(formatPracticeEntry(entry)).toBe(line);
  });

  it('round-trips multiple-choice cards through parse', () => {
    const line = formatPracticeEntry({
      id: '',
      cardType: CardType.MULTIPLE_CHOICE,
      bank: 'Grammar',
      question: '你__狗吗？',
      answer: '有没有',
      distractors: ['不有', '没不有'],
    });
    const [entry] = parsePracticeList(line);
    expect(entry).toEqual({
      id: computeMultiChoiceId('Grammar', '你__狗吗？', '有没有'),
      cardType: CardType.MULTIPLE_CHOICE,
      bank: 'Grammar',
      question: '你__狗吗？',
      answer: '有没有',
      distractors: ['不有', '没不有'],
    });
    expect(formatPracticeEntry(entry)).toBe(line);
  });

  it('keeps | out of multiple-choice option text so the list splits right', () => {
    const line = formatPracticeEntry({
      id: '',
      cardType: CardType.MULTIPLE_CHOICE,
      bank: 'Grammar',
      question: 'pick',
      answer: 'a|b',
      distractors: ['c|d', ''],
    });
    const [entry] = parsePracticeList(line);
    expect(entry).toMatchObject({answer: 'a/b', distractors: ['c/d']});
  });

  it('round-trips cloze cards through parse', () => {
    const line = formatPracticeEntry({
      id: '',
      cardType: CardType.CLOZE,
      bank: 'Cloze',
      text: '我一个星期{{没}}吃饭。',
      hint: "I haven't eaten for a week.",
    });
    const [entry] = parsePracticeList(line);
    expect(entry).toEqual({
      id: computeClozeId('Cloze', '我一个星期{{没}}吃饭。'),
      cardType: CardType.CLOZE,
      bank: 'Cloze',
      text: '我一个星期{{没}}吃饭。',
      hint: "I haven't eaten for a week.",
    });
    expect(formatPracticeEntry(entry)).toBe(line);
  });

  it('collapses tabs and newlines in flashcard text (line format survives)', () => {
    const line = formatPracticeEntry({
      id: '',
      cardType: CardType.FLASHCARD,
      bank: 'Capitals',
      front: 'What is\nthe capital\tof France?',
      back: 'Paris',
    });
    expect(line.split('\n')).toHaveLength(1);
    const [entry] = parsePracticeList(line);
    expect(entry.cardType).toBe(CardType.FLASHCARD);
    if (entry.cardType === CardType.FLASHCARD) {
      expect(entry.front).toBe('What is the capital of France?');
    }
  });
});

describe('sanitizeField', () => {
  it('collapses tabs, CRs and newlines to single spaces and trims', () => {
    expect(sanitizeField('  a\tb\r\nc  ')).toBe('a b c');
  });
});

describe('sanitizeOption', () => {
  it('replaces | (the distractor separator) and collapses whitespace', () => {
    expect(sanitizeOption(' a|b\tc ')).toBe('a/b c');
  });
});

describe('parseClozeSegments', () => {
  it('splits literal text and {{blank}} runs in order', () => {
    expect(parseClozeSegments('我一个星期{{没}}吃饭。')).toEqual([
      {text: '我一个星期', blank: false},
      {text: '没', blank: true},
      {text: '吃饭。', blank: false},
    ]);
  });

  it('handles multiple blanks and blanks at the edges', () => {
    expect(parseClozeSegments('{{如果}}你有时间，{{就}}来')).toEqual([
      {text: '如果', blank: true},
      {text: '你有时间，', blank: false},
      {text: '就', blank: true},
      {text: '来', blank: false},
    ]);
  });

  it('returns one literal segment when there is no blank', () => {
    expect(parseClozeSegments('没有空')).toEqual([
      {text: '没有空', blank: false},
    ]);
    expect(parseClozeSegments('')).toEqual([{text: '', blank: false}]);
  });
});

describe('entryLabel', () => {
  it('labels multiple-choice cards as question (answer)', () => {
    expect(
      entryLabel({
        id: 'deadbeef',
        cardType: CardType.MULTIPLE_CHOICE,
        bank: 'Grammar',
        question: '你__狗吗？',
        answer: '有没有',
        distractors: ['不有'],
      }),
    ).toBe('你__狗吗？ (有没有)');
  });

  it('labels cloze cards with the blanks in brackets plus the hint', () => {
    expect(
      entryLabel({
        id: 'deadbeef',
        cardType: CardType.CLOZE,
        bank: 'Cloze',
        text: '我一个星期{{没}}吃饭。',
        hint: 'duration before negation',
      }),
    ).toBe('我一个星期[没]吃饭。 (duration before negation)');
    expect(
      entryLabel({
        id: 'deadbeef',
        cardType: CardType.CLOZE,
        bank: 'Cloze',
        text: '四{{个}}月',
        hint: '',
      }),
    ).toBe('四[个]月');
  });
});

describe('listBanks', () => {
  it('returns distinct banks sorted, with Hanzi first', () => {
    const entries = parsePracticeList(
      [
        'France\tParis\t\t\t1\tCapitals',
        '好\thao3\tgood',
        'Spain\tMadrid\t\t\t1\tCapitals',
        'dog\tHund\t\t\t2\tGerman',
      ].join('\n'),
    );
    expect(listBanks(entries)).toEqual([HANZI_BANK, 'Capitals', 'German']);
  });
});
