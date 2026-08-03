import {CedictParser} from '../src/dictionary/cedict_parser';
import {
  lookupDefinitions,
  PickPrimarySense,
} from '../src/dictionary/definition_lookup';

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

describe('PickPrimarySense', () => {
  const sense = (pinyin: string, english: string) => ({
    traditional: 'X',
    simplified: 'X',
    pinyin,
    english,
  });

  it('skips a surname sense — the real CEDICT order for 车', () => {
    // 車 车 [Che1] /surname Che/ comes FIRST in the dictionary file.
    expect(
      PickPrimarySense([
        sense('Che1', 'surname Che'),
        sense('che1', 'car/vehicle/CL:輛|辆[liang4]'),
        sense('ju1', 'war chariot (archaic)'),
      ]),
    ).toMatchObject({pinyin: 'che1'});
  });

  it('skips colloquial and cross-reference senses — the real order for 吗', () => {
    expect(
      PickPrimarySense([
        sense('ma2', '(coll.) what?'),
        sense('ma3', 'used in 嗎啡|吗啡[ma3fei1]'),
        sense('ma5', '(question particle for "yes-no" questions)'),
      ]),
    ).toMatchObject({pinyin: 'ma5'});
  });

  it('skips a "used in" sense — the real order for 个', () => {
    expect(
      PickPrimarySense([
        sense('ge3', 'used in 自個兒|自个儿[zi4 ge3 r5]'),
        sense('ge4', '(classifier used before a noun...)'),
      ]),
    ).toMatchObject({pinyin: 'ge4'});
  });

  it('leaves an ordinary character on its first sense', () => {
    expect(
      PickPrimarySense([
        sense('hao3', 'good/appropriate; proper'),
        sense('hao4', 'to be fond of'),
      ]),
    ).toMatchObject({pinyin: 'hao3'});
    expect(PickPrimarySense([sense('wo3', 'I; me; my')])).toMatchObject({
      pinyin: 'wo3',
    });
  });

  it('falls back to the first sense when every sense is marked', () => {
    // A character whose only reading is a surname still deserves a reading.
    expect(
      PickPrimarySense([
        sense('Zhao4', 'surname Zhao'),
        sense('Qian2', 'surname Qian'),
      ]),
    ).toMatchObject({pinyin: 'Zhao4'});
  });

  it('has nothing to pick from an empty list', () => {
    expect(PickPrimarySense([])).toBeUndefined();
  });
});
