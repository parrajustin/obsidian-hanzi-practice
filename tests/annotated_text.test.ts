/**
 * Per-character readings on card text. The load-bearing behaviours: the
 * annotation line is ALWAYS reserved (so learning a character does not reflow
 * the card), a known character shows an empty one, and text with no hanzi
 * renders exactly as it did before annotations existed.
 */

import {
  AnnotationLookup,
  AnnotationTextFor,
  HasHanzi,
  renderAnnotatedText,
} from '../src/components/annotated_text';
import {KNOWN_LEVEL} from '../src/character_progress';

const lookup: AnnotationLookup = char =>
  ({
    开: {prettyPinyin: 'kāi', level: 1},
    车: {prettyPinyin: 'chē', level: KNOWN_LEVEL}, // known → no reading
    龘: {prettyPinyin: '', level: 0}, // tracked, but no dictionary reading
  })[char];

const host = () => document.createElement('div');

describe('HasHanzi', () => {
  it('is true only when there is something to annotate', () => {
    expect(HasHanzi('开车')).toBe(true);
    expect(HasHanzi('a 车 b')).toBe(true);
    expect(HasHanzi('Paris')).toBe(false);
    expect(HasHanzi('')).toBe(false);
  });
});

describe('AnnotationTextFor', () => {
  it('shows the reading below the known level and hides it at or above', () => {
    expect(AnnotationTextFor({prettyPinyin: 'kāi', level: 0})).toBe('kāi');
    expect(
      AnnotationTextFor({prettyPinyin: 'kāi', level: KNOWN_LEVEL - 1}),
    ).toBe('kāi');
    expect(AnnotationTextFor({prettyPinyin: 'kāi', level: KNOWN_LEVEL})).toBe(
      '',
    );
    expect(AnnotationTextFor({prettyPinyin: 'kāi', level: 5})).toBe('');
  });

  it('has nothing to show for an untracked character', () => {
    expect(AnnotationTextFor(undefined)).toBe('');
  });
});

describe('renderAnnotatedText', () => {
  it('gives every character a reading line, empty once it is known', () => {
    const parent = host();
    renderAnnotatedText(parent, '开车', lookup, 'flash-card-front');

    const units = parent.querySelectorAll('.hanzi-annotated-unit');
    expect(units).toHaveLength(2);
    const readings = Array.from(
      parent.querySelectorAll('.hanzi-annotated-pinyin'),
    ).map(el => el.textContent);
    // 开 is still being learned; 车 is known, so its line is reserved but blank.
    expect(readings).toEqual(['kāi', '']);
    expect(
      Array.from(parent.querySelectorAll('.hanzi-annotated-char')).map(
        el => el.textContent,
      ),
    ).toEqual(['开', '车']);
  });

  it('reserves the line height even when the reading is empty', () => {
    const parent = host();
    renderAnnotatedText(parent, '车', lookup);
    const reading = parent.querySelector(
      '.hanzi-annotated-pinyin',
    ) as HTMLElement;
    // The reserved line is what stops the card reflowing the moment a
    // character is learned.
    expect(reading).not.toBeNull();
    expect(reading.style.minHeight).toBe('1.2em');
  });

  it('exposes the raw text, so assertions never read the interleaved DOM', () => {
    const parent = host();
    const el = renderAnnotatedText(parent, '开车', lookup);
    expect(el.dataset.text).toBe('开车');
    // textContent interleaves readings — this is exactly why data-text exists.
    expect(el.textContent).not.toBe('开车');
  });

  it('tags each unit with its character and level for tests and the E2E', () => {
    const parent = host();
    renderAnnotatedText(parent, '开车', lookup);
    const units = Array.from(
      parent.querySelectorAll<HTMLElement>('.hanzi-annotated-unit'),
    );
    expect(units.map(u => u.dataset.char)).toEqual(['开', '车']);
    expect(units.map(u => u.dataset.level)).toEqual(['1', String(KNOWN_LEVEL)]);
  });

  it('renders plain text when there is no hanzi — English decks look unchanged', () => {
    const parent = host();
    const el = renderAnnotatedText(
      parent,
      'France',
      lookup,
      'flash-card-front',
    );
    expect(el.textContent).toBe('France');
    expect(el.querySelector('.hanzi-annotated-unit')).toBeNull();
    expect(el.classList.contains('flash-card-front')).toBe(true);
  });

  it('renders plain text when no ledger has been synced yet', () => {
    const parent = host();
    const el = renderAnnotatedText(parent, '开车', undefined);
    expect(el.textContent).toBe('开车');
    expect(el.querySelector('.hanzi-annotated-unit')).toBeNull();
  });

  it('keeps latin runs whole and leaves untracked characters unannotated', () => {
    const parent = host();
    renderAnnotatedText(parent, '开 (go) 龘', lookup);
    const units = Array.from(
      parent.querySelectorAll<HTMLElement>('.hanzi-annotated-unit'),
    );
    expect(
      units.map(u => u.querySelector('.hanzi-annotated-char')?.textContent),
    ).toEqual(['开', ' (go) ', '龘']);
    const readings = units.map(
      u => u.querySelector('.hanzi-annotated-pinyin')?.textContent,
    );
    // The latin run and the reading-less character both get a blank line.
    expect(readings).toEqual(['kāi', '', '']);
  });
});
