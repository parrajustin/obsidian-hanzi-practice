/**
 * Chinese text utilities shared by the character ledger, the ruby renderer
 * and the pinyin-stripping migration.
 *
 * Everything here is pure string work: no vault, no dictionary, no DOM — so
 * the rules that decide "is this a character I track" and "is this prefix
 * pinyin" are testable in isolation, which matters because both decisions
 * silently reshape the user's card files.
 */

/**
 * CJK ranges that count as a practiceable character. Deliberately NOT the
 * whole CJK space: punctuation (，。？！) and the fullwidth forms are not
 * characters to learn, and treating them as such would fill the ledger with
 * entries no dictionary can define.
 */
const HANZI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3400, 0x4dbf], // Extension A
  [0xf900, 0xfaff], // Compatibility Ideographs
];

/** Whether one code point is a hanzi (not punctuation, not latin, not kana). */
export function IsHanziChar(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  return HANZI_RANGES.some(([start, end]) => code >= start && code <= end);
}

/**
 * Every hanzi in the text, in first-appearance order, without duplicates —
 * the ledger tracks a character once no matter how often a card repeats it.
 */
export function ExtractHanzi(text: string): string[] {
  const seen = new Set<string>();
  const chars: string[] = [];
  for (const char of text) {
    if (!IsHanziChar(char) || seen.has(char)) continue;
    seen.add(char);
    chars.push(char);
  }
  return chars;
}

/** One rendering unit: a hanzi that can carry a pinyin annotation, or not. */
export interface TextSegment {
  text: string;
  hanzi: boolean;
}

/**
 * Split text into per-character segments for ruby rendering: each hanzi is its
 * own segment (it gets its own annotation), while runs of everything else stay
 * together so latin words and punctuation are not sliced up.
 */
export function SplitForAnnotation(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let plain = '';
  for (const char of text) {
    if (IsHanziChar(char)) {
      if (plain.length > 0) {
        segments.push({text: plain, hanzi: false});
        plain = '';
      }
      segments.push({text: char, hanzi: true});
      continue;
    }
    plain += char;
  }
  if (plain.length > 0) segments.push({text: plain, hanzi: false});
  return segments;
}

/** The separator study-pack cards use between pinyin and the meaning. */
const PINYIN_SEPARATOR = ' — ';

/** Tone-marked vowels — the signal that a latin prefix really is pinyin. */
const TONE_MARKS = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňǹ]/i;

/** Characters a pinyin transcription may legally contain. */
const PINYIN_CHARS = /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùüǖǘǚǜńňǹ'·\s0-5]+$/i;

/**
 * Strip a leading `pīnyīn — ` from card text, returning the meaning alone.
 *
 * Study-pack cards were authored as `kāichē — to drive (a car)`, which bakes
 * the reading into the answer and makes it impossible to hide once the reader
 * knows the characters. The reading now comes from the character ledger
 * instead, so the stored text keeps only the meaning.
 *
 * The prefix must LOOK like pinyin to be removed: no hanzi, only
 * pinyin-legal characters, and at least one tone mark. That last rule is what
 * keeps `Paris — capital of France` intact — an em-dash alone is not evidence
 * of a reading, and silently eating a card's answer would be far worse than
 * leaving a reading in place.
 */
export function StripEmbeddedPinyin(text: string): string {
  const separator = text.indexOf(PINYIN_SEPARATOR);
  if (separator === -1) return text;
  const prefix = text.slice(0, separator).trim();
  const rest = text.slice(separator + PINYIN_SEPARATOR.length).trim();
  if (prefix.length === 0 || rest.length === 0) return text;
  if (ExtractHanzi(prefix).length > 0) return text;
  if (!TONE_MARKS.test(prefix)) return text;
  if (!PINYIN_CHARS.test(prefix)) return text;
  return rest;
}
