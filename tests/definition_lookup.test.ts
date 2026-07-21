import {CedictParser} from '../src/dictionary/cedict_parser';
import {lookupDefinitions} from '../src/dictionary/definition_lookup';

const SAMPLE = [
  '# CC-CEDICT sample',
  '好 好 [hao3] /good/well/proper/',
  '好 好 [hao4] /to be fond of/to have a tendency to/',
  '喂 喂 [wei4] /to feed/',
  '喂 喂 [wei2] /hello (when answering the phone)/',
  '漢 汉 [han4] /Han ethnic group/Chinese (language)/',
].join('\n');

function makeParser(): CedictParser {
  const parser = new CedictParser();
  parser.parse(SAMPLE);
  return parser;
}

describe('lookupDefinitions', () => {
  test('returns every sense of a character, in dictionary order', () => {
    const entries = lookupDefinitions(makeParser(), '好');
    expect(entries.map(e => e.pinyin)).toEqual(['hao3', 'hao4']);
    expect(entries[0].english).toBe('good/well/proper');
    expect(entries[1].english).toBe('to be fond of/to have a tendency to');
  });

  test('dedupes the identical simplified/traditional payloads', () => {
    // 喂 is its own traditional form, so it lives in both tries with the same
    // payload — the lookup must not return each sense twice.
    const entries = lookupDefinitions(makeParser(), '喂');
    expect(entries).toHaveLength(2);
    expect(entries.map(e => e.pinyin)).toEqual(['wei4', 'wei2']);
  });

  test('finds simplified-only and traditional-only forms', () => {
    const simplified = lookupDefinitions(makeParser(), '汉');
    expect(simplified).toHaveLength(1);
    expect(simplified[0].pinyin).toBe('han4');

    const traditional = lookupDefinitions(makeParser(), '漢');
    expect(traditional).toHaveLength(1);
    expect(traditional[0].english).toBe('Han ethnic group/Chinese (language)');
  });

  test('returns an empty list for characters not in the dictionary', () => {
    expect(lookupDefinitions(makeParser(), '猫')).toEqual([]);
    expect(lookupDefinitions(makeParser(), '')).toEqual([]);
  });
});
