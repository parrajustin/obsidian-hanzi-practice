/**
 * Describes practice entries for the debug log.
 *
 * Every card-related log line carries the SAME shape, so a bug report can be
 * read as a sequence of "which card, in which format, from which bank" — the
 * identity you need to correlate a rendering complaint with the entry that
 * produced it.
 */

import {
  CardType,
  IsClozeEntry,
  IsFlashcardEntry,
  IsMultiChoiceEntry,
  IsTrueFalseEntry,
  PracticeEntry,
} from '../utils/practice_list';

/** How long a free-text field may be before the log truncates it. */
const MAX_PREVIEW = 60;

function preview(text: string): string {
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text;
}

/** The human name of a card type, so logs do not read as bare numbers. */
export function cardTypeName(cardType: number | undefined): string {
  return CardType[cardType ?? CardType.HANZI] ?? `UNKNOWN(${cardType})`;
}

/**
 * Identity + shape of one entry: id, card type (number AND name), bank, and a
 * truncated preview of the fields that define what the user actually sees.
 * Never includes a card's answer beyond what is needed to identify it.
 */
export function describeEntry(
  entry: PracticeEntry | null,
): Record<string, unknown> {
  if (entry === null) return {card: null};
  const base = {
    id: entry.id,
    cardType: entry.cardType ?? CardType.HANZI,
    cardTypeName: cardTypeName(entry.cardType),
    bank: entry.bank,
    hasExplanation: Boolean(entry.explanation),
  };
  if (IsFlashcardEntry(entry)) {
    return {
      ...base,
      front: preview(entry.front),
      back: preview(entry.back),
      reversible: entry.cardType === CardType.REVERSIBLE_FLASHCARD,
    };
  }
  if (IsMultiChoiceEntry(entry)) {
    return {
      ...base,
      question: preview(entry.question),
      answer: preview(entry.answer),
      distractorCount: entry.distractors.length,
    };
  }
  if (IsClozeEntry(entry)) {
    return {...base, text: preview(entry.text), hint: preview(entry.hint)};
  }
  if (IsTrueFalseEntry(entry)) {
    return {
      ...base,
      statement: preview(entry.statement),
      isCorrect: entry.isCorrect,
    };
  }
  return {
    ...base,
    character: entry.character,
    pinyin: entry.pinyin,
    english: preview(entry.english),
  };
}
