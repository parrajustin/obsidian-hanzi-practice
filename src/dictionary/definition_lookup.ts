import {WrapToResult} from 'standard-ts-lib/src/wrap_to_result';
import {CedictEntry, CedictParser} from './cedict_parser';

/**
 * Look up every CEDICT entry for `input` (simplified or traditional). Each
 * CEDICT line is one sense, so a character like 好 (hao3 "good" / hao4 "to be
 * fond of") or 喂 (wei4 "to feed" / wei2 "hello?") returns multiple entries,
 * in dictionary-file order. A character whose simplified and traditional forms
 * are identical is stored in both tries with the same payload — those
 * duplicates are collapsed here.
 */
export function lookupDefinitions(
  dict: CedictParser,
  input: string,
): CedictEntry[] {
  const raw = [
    ...(dict.simplifiedTrie.search(input) ?? []),
    ...(dict.traditionalTrie.search(input) ?? []),
  ];
  const seen = new Set<string>();
  const entries: CedictEntry[] = [];
  for (const json of raw) {
    if (seen.has(json)) continue;
    seen.add(json);
    const parsed = WrapToResult(
      () => JSON.parse(json) as CedictEntry,
      'Failed to parse dictionary entry',
    );
    // A malformed trie payload only invalidates that one sense; keep the rest.
    if (parsed.ok) entries.push(parsed.val);
  }
  return entries;
}

/**
 * Definition prefixes that mark a SECONDARY sense: a cross-reference, a
 * variant spelling, or a colloquialism. CEDICT lists senses in an order that
 * has nothing to do with frequency — 车's first sense is the surname "Che",
 * 吗's is the colloquial "what?", 个's is "used in 自個兒" — so a tool that
 * takes the first sense teaches the wrong reading.
 */
const SECONDARY_SENSE_PREFIXES = [
  'surname ',
  'used in ',
  'variant of',
  'old variant of',
  'unofficial variant of',
  'abbr. for',
  'see ',
  '(coll.)',
];

/** Lower is better. 0 = an ordinary sense, 1 = one of the marked ones. */
function sensePenalty(entry: CedictEntry): number {
  // CEDICT capitalises the pinyin of proper nouns (`Che1` vs `che1`), which
  // is the most reliable "this is a name, not the word" signal it has.
  if (/^[A-Z]/.test(entry.pinyin)) return 1;
  const english = entry.english.trim().toLowerCase();
  return SECONDARY_SENSE_PREFIXES.some(prefix => english.startsWith(prefix))
    ? 1
    : 0;
}

/**
 * The sense to teach for a character: the first one that is not a surname,
 * variant or colloquialism, falling back to the first sense when every
 * candidate is marked (a character whose only reading IS a surname still
 * deserves a reading). Dictionary order breaks ties, so the common sense of an
 * ordinary character is untouched.
 */
export function PickPrimarySense(
  senses: readonly CedictEntry[],
): CedictEntry | undefined {
  let best: CedictEntry | undefined;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (const sense of senses) {
    const penalty = sensePenalty(sense);
    if (penalty < bestPenalty) {
      best = sense;
      bestPenalty = penalty;
      if (penalty === 0) break;
    }
  }
  return best;
}
