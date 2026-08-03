/**
 * The migration that takes readings out of card files. It rewrites the user's
 * study material in place, so the two properties that matter are: it never
 * touches anything but the text fields, and running it twice is a no-op.
 */

import {StripPinyinFromCardFile} from '../src/utils/migrate_pinyin';
import {CardType, parsePracticeList} from '../src/utils/practice_list';

const line = (...fields: string[]) => fields.join('\t');

describe('StripPinyinFromCardFile', () => {
  it('removes the reading and keeps every other field byte-for-byte', () => {
    const before = line(
      '开车',
      'kāichē — to drive (a car)',
      '',
      '5444b678',
      '1',
      'L2 Words',
    );
    const {text, changed} = StripPinyinFromCardFile(before);

    expect(changed).toBe(1);
    expect(text).toBe(
      line('开车', 'to drive (a car)', '', '5444b678', '1', 'L2 Words'),
    );
    // The id column is what keeps the card's review history attached.
    const [entry] = parsePracticeList(text);
    expect(entry).toMatchObject({
      id: '5444b678',
      cardType: CardType.FLASHCARD,
      bank: 'L2 Words',
      back: 'to drive (a car)',
    });
  });

  it('keeps a trailing explanation field intact', () => {
    const before = line(
      '她是很好。',
      'false',
      '',
      'b4aa9173',
      '5',
      'L1 Grammar',
      '是 means equals and only works with nouns.',
    );
    expect(StripPinyinFromCardFile(before).text).toBe(before);
  });

  it('counts only the lines it changed', () => {
    const text = [
      line('开车', 'kāichē — to drive', '', 'a', '1', 'L2 Words'),
      line('骑车', 'qíchē — to ride', '', 'b', '1', 'L2 Words'),
      line('France', 'Paris', '', 'c', '1', 'Capitals'),
    ].join('\n');
    const result = StripPinyinFromCardFile(text);
    expect(result.changed).toBe(2);
    expect(result.text).toContain('to drive');
    expect(result.text).toContain('Paris');
    expect(result.text).not.toContain('kāichē');
  });

  it('leaves markdown scaffolding and blank lines exactly as they were', () => {
    const text = [
      '# Character progress',
      '',
      '<!-- generated -->',
      '| 好 | hǎo — good | 4 |',
      '',
      line('好', 'hǎo — good', '', 'id', '1', 'L1 Words'),
    ].join('\n');
    const result = StripPinyinFromCardFile(text);
    expect(result.changed).toBe(1);
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('# Character progress');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('<!-- generated -->');
    // A table row is not a card, even though it contains a reading.
    expect(lines[3]).toBe('| 好 | hǎo — good | 4 |');
    expect(lines[5]).toBe(line('好', 'good', '', 'id', '1', 'L1 Words'));
  });

  it('is idempotent — a second run changes nothing', () => {
    const before = line('开车', 'kāichē — to drive', '', 'a', '1', 'L2 Words');
    const once = StripPinyinFromCardFile(before);
    const twice = StripPinyinFromCardFile(once.text);
    expect(twice.changed).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  it('preserves the line count and trailing newline of the file', () => {
    const text = `${line('开车', 'kāichē — to drive', '', 'a', '1', 'B')}\n`;
    const result = StripPinyinFromCardFile(text);
    expect(result.text.split('\n')).toHaveLength(2);
    expect(result.text.endsWith('\n')).toBe(true);
  });

  it('never touches a hanzi card, whose second field IS its reading', () => {
    const before = line('好', 'hao3', 'good/well', 'id', '0', 'Hanzi');
    expect(StripPinyinFromCardFile(before).changed).toBe(0);
  });
});
