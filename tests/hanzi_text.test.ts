import {
  ExtractHanzi,
  IsHanziChar,
  SplitForAnnotation,
  StripEmbeddedPinyin,
} from '../src/utils/hanzi_text';

describe('IsHanziChar', () => {
  it.each(['好', '车', '龍', '㐀'])('accepts the hanzi %s', char => {
    expect(IsHanziChar(char)).toBe(true);
  });

  it.each(['a', '1', ' ', '，', '。', '？', 'ā', 'ひ', ''])(
    'rejects %s — punctuation and latin are not characters to learn',
    char => {
      expect(IsHanziChar(char)).toBe(false);
    },
  );
});

describe('ExtractHanzi', () => {
  it('returns each character once, in first-appearance order', () => {
    expect(ExtractHanzi('你喜欢开车还是骑车？')).toEqual([
      '你',
      '喜',
      '欢',
      '开',
      '车',
      '还',
      '是',
      '骑',
    ]);
  });

  it('ignores latin, digits and CJK punctuation', () => {
    expect(ExtractHanzi('I like 车 (a car)，really！')).toEqual(['车']);
    expect(ExtractHanzi('no chinese here')).toEqual([]);
  });
});

describe('SplitForAnnotation', () => {
  it('gives every hanzi its own segment and keeps other runs whole', () => {
    expect(SplitForAnnotation('我有2个car。')).toEqual([
      {text: '我', hanzi: true},
      {text: '有', hanzi: true},
      {text: '2', hanzi: false},
      {text: '个', hanzi: true},
      {text: 'car。', hanzi: false},
    ]);
  });

  it('handles text with no hanzi and empty text', () => {
    expect(SplitForAnnotation('Paris')).toEqual([
      {text: 'Paris', hanzi: false},
    ]);
    expect(SplitForAnnotation('')).toEqual([]);
  });
});

describe('StripEmbeddedPinyin', () => {
  it('removes the reading from study-pack card backs', () => {
    expect(StripEmbeddedPinyin('kāichē — to drive (a car)')).toBe(
      'to drive (a car)',
    );
    expect(StripEmbeddedPinyin('zìxíngchē — bicycle')).toBe('bicycle');
    expect(StripEmbeddedPinyin('gōngjiāochē — bus')).toBe('bus');
  });

  it('leaves text alone when the prefix is not a reading', () => {
    // The em dash alone is not evidence: eating a real answer would be worse
    // than leaving a reading in place.
    expect(StripEmbeddedPinyin('Paris — capital of France')).toBe(
      'Paris — capital of France',
    );
    expect(StripEmbeddedPinyin('开车 — to drive')).toBe('开车 — to drive');
    expect(StripEmbeddedPinyin('to drive (a car)')).toBe('to drive (a car)');
  });

  it('leaves degenerate lines alone', () => {
    expect(StripEmbeddedPinyin('')).toBe('');
    expect(StripEmbeddedPinyin(' — bus')).toBe(' — bus');
    expect(StripEmbeddedPinyin('kāichē — ')).toBe('kāichē — ');
  });

  it('only strips the FIRST separator, keeping dashes in the meaning', () => {
    expect(StripEmbeddedPinyin('hǎo — good — fine')).toBe('good — fine');
  });

  it('is idempotent — migrating twice cannot damage a card', () => {
    const once = StripEmbeddedPinyin('kāichē — to drive (a car)');
    expect(StripEmbeddedPinyin(once)).toBe(once);
  });
});
