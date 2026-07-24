import {
  ConstructOtherOptions,
  prettifyPinyin,
} from '../src/utils/prettify_pinyin';

describe('prettifyPinyin', () => {
  it('places the tone mark on the vowel', () => {
    expect(prettifyPinyin('hao3')).toBe('hǎo');
    expect(prettifyPinyin('ma1')).toBe('mā');
    expect(prettifyPinyin('shi4')).toBe('shì');
    expect(prettifyPinyin('wen2')).toBe('wén');
  });

  it('strips the digit for neutral tone 5 and tone-less input', () => {
    expect(prettifyPinyin('ma5')).toBe('ma');
    expect(prettifyPinyin('men')).toBe('men');
  });

  it('applies the medial rule (mark shifts off i/u/ü onto the next vowel)', () => {
    expect(prettifyPinyin('jiu3')).toBe('jiǔ');
    expect(prettifyPinyin('hua4')).toBe('huà');
    expect(prettifyPinyin('xiao3')).toBe('xiǎo');
  });

  it('converts v to ü in both toned and tone-less syllables', () => {
    expect(prettifyPinyin('nv3')).toBe('nǚ');
    expect(prettifyPinyin('nv')).toBe('nü');
  });

  it('preserves upper case on the toned vowel', () => {
    expect(prettifyPinyin('Ai4')).toBe('Ài');
  });

  it('handles multi-syllable pinyin space-separated', () => {
    expect(prettifyPinyin('han4 yu3')).toBe('hàn yǔ');
  });

  it('passes through syllables with no vowel at all', () => {
    expect(prettifyPinyin('hm2')).toBe('hm');
  });
});

describe('ConstructOtherOptions', () => {
  it('returns the four other tones of the same syllable', () => {
    expect(ConstructOtherOptions('hao3')).toEqual(['hāo', 'háo', 'hào', 'hao']);
  });

  it('returns [] when the input has no tone digit', () => {
    expect(ConstructOtherOptions('hao')).toEqual([]);
  });
});
