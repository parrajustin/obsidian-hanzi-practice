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
