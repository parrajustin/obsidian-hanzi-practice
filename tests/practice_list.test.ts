import {
  computeEntryId,
  formatPracticeEntry,
  parsePracticeList,
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
});

describe('parsePracticeList', () => {
  it('parses current 4-field lines, keeping the stored id', () => {
    const entries = parsePracticeList('好\thao3\tgood/proper\tdeadbeef');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: 'deadbeef',
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
});

describe('formatPracticeEntry', () => {
  it('writes the id as the 4th tab-separated field', () => {
    const line = formatPracticeEntry({
      id: 'deadbeef',
      character: '好',
      pinyin: 'hao3',
      english: 'good',
    });
    expect(line).toBe('好\thao3\tgood\tdeadbeef');
  });

  it('derives a missing id, and round-trips through parse', () => {
    const line = formatPracticeEntry({
      id: '',
      character: '好',
      pinyin: 'hao4',
      english: 'to be fond of',
    });
    const [entry] = parsePracticeList(line);
    expect(entry.id).toBe(computeEntryId('好', 'hao4'));
    expect(line.endsWith(`\t${entry.id}`)).toBe(true);
    expect(formatPracticeEntry(entry)).toBe(line);
  });
});
