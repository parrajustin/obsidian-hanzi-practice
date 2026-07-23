import {
  CardType,
  computeEntryId,
  computeFlashcardId,
  formatPracticeEntry,
  HANZI_BANK,
  listBanks,
  parsePracticeList,
  sanitizeField,
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
