/**
 * Card text with per-character readings above it (ruby annotation).
 *
 * The reading is what a learner leans on until they don't need it: each hanzi
 * carries its own pinyin, and a character that has reached `KNOWN_LEVEL`
 * simply renders an EMPTY annotation instead of being dropped from the layout.
 * That is deliberate — the line above the text keeps its height whether or not
 * a reading is in it, so a card does not reflow (and the eye does not have to
 * re-find the text) the moment a character is learned.
 *
 * Text with no hanzi renders as a plain text node: a deck of English cards
 * must look exactly as it did before annotations existed.
 */

import {ShouldShowPinyin} from '../character_progress';
import {IsHanziChar, SplitForAnnotation} from '../utils/hanzi_text';

/** What the renderer needs to know about one character. */
export interface CharacterAnnotation {
  /** Display reading (`hǎo`); empty when the dictionary had none. */
  prettyPinyin: string;
  level: number;
}

/** Reading + level for a character, or undefined when it is not tracked. */
export type AnnotationLookup = (
  char: string,
) => CharacterAnnotation | undefined;

/** Whether this text has anything worth annotating. */
export function HasHanzi(text: string): boolean {
  for (const char of text) {
    if (IsHanziChar(char)) return true;
  }
  return false;
}

/**
 * The reading to show above one character: the annotation's pinyin, unless the
 * character is known well enough to go without (or has no reading at all).
 */
export function AnnotationTextFor(
  annotation: CharacterAnnotation | undefined,
): string {
  if (!annotation) return '';
  if (!ShouldShowPinyin(annotation.level)) return '';
  return annotation.prettyPinyin;
}

/**
 * Render `text` into `parent`, annotating each hanzi. Returns the element the
 * text was rendered into.
 */
export function renderAnnotatedText(
  parent: HTMLElement,
  text: string,
  lookup: AnnotationLookup | undefined,
  cls?: string,
): HTMLElement {
  const container = parent.createDiv({cls: cls ?? ''});
  // The raw text, unpolluted by the readings: `textContent` on an annotated
  // element interleaves pinyin with the characters, so anything asserting on
  // "what the card says" (tests, the E2E, a screenshot comparison) reads this.
  container.dataset.text = text;
  if (lookup === undefined || !HasHanzi(text)) {
    // No annotations to add: keep the plain-text DOM the rest of the plugin
    // (and its screenshots) already expect.
    container.setText(text);
    return container;
  }
  container.addClass('hanzi-annotated');
  container.style.display = 'flex';
  container.style.flexWrap = 'wrap';
  container.style.justifyContent = 'center';
  container.style.alignItems = 'flex-end';

  for (const segment of SplitForAnnotation(text)) {
    const annotation = segment.hanzi ? lookup(segment.text) : undefined;
    const reading = segment.hanzi ? AnnotationTextFor(annotation) : '';
    const unit = container.createDiv({cls: 'hanzi-annotated-unit'});
    unit.style.display = 'inline-flex';
    unit.style.flexDirection = 'column';
    unit.style.alignItems = 'center';
    if (segment.hanzi) {
      unit.dataset.char = segment.text;
      unit.dataset.level = String(annotation?.level ?? 0);
    }
    // ALWAYS created, even when empty: this is the reserved line that keeps
    // the card from reflowing when a character is finally learned.
    const pinyinEl = unit.createDiv({
      cls: 'hanzi-annotated-pinyin',
      text: reading,
    });
    pinyinEl.style.fontSize = '0.6em';
    pinyinEl.style.lineHeight = '1.2';
    pinyinEl.style.minHeight = '1.2em';
    pinyinEl.style.color = 'var(--text-muted)';
    pinyinEl.style.whiteSpace = 'pre';
    unit.createDiv({cls: 'hanzi-annotated-char', text: segment.text});
  }
  return container;
}
