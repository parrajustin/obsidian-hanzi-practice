/**
 * Migration: take the readings out of card text.
 *
 * Study-pack cards were authored with the reading baked into the answer
 * (`kāichē — to drive (a car)`), which makes it impossible to hide once the
 * reader knows the characters. The reading now comes from the character
 * ledger, so the card keeps only the meaning.
 *
 * The rewrite is LINE-level on purpose: fields are split, the text fields are
 * stripped, and everything else — id, card type, bank, explanation — is
 * written back byte-for-byte. Round-tripping through the parser would risk
 * normalising away data this migration has no business touching, and the id
 * column is what keeps every card's review history attached.
 */

import {StripEmbeddedPinyin} from './hanzi_text';

/** Field separator of the card line format (see practice_list.ts). */
const FIELD_SEP = '\t';

/** Fields that hold text a reader sees; the rest are ids and metadata. */
const TEXT_FIELDS = [0, 1, 2];

export interface PinyinMigrationResult {
  text: string;
  /** How many lines changed. */
  changed: number;
}

/**
 * Strip embedded readings from one card file's text. Lines that are not cards
 * (markdown scaffolding, blank lines) and cards with no embedded reading are
 * returned untouched, so running this twice changes nothing the second time.
 */
export function StripPinyinFromCardFile(text: string): PinyinMigrationResult {
  let changed = 0;
  const lines = text.split('\n').map(raw => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) return raw;
    if (/^\s*(#|\||<!--|-->|>)/.test(line)) return raw;
    const parts = line.split(FIELD_SEP);
    // A single-field line is legacy free text, not a card with an answer.
    if (parts.length < 2) return raw;
    let touched = false;
    for (const index of TEXT_FIELDS) {
      const field = parts[index];
      if (field === undefined) continue;
      const stripped = StripEmbeddedPinyin(field);
      if (stripped === field) continue;
      parts[index] = stripped;
      touched = true;
    }
    if (!touched) return raw;
    changed++;
    return parts.join(FIELD_SEP);
  });
  return {text: lines.join('\n'), changed};
}
