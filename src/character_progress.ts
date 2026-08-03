/**
 * Per-character progress: how well one hanzi is known, from the reviews it has
 * collected — both its own drills and the credit it earns inside sentence
 * cards (see `HistoryManager.creditCharacters`).
 *
 * This is the model behind "the pinyin disappears as I learn": a character's
 * LEVEL decides whether its reading is still shown above it, so the rule has
 * to be conservative. One lucky sentence must not silently strip a reading the
 * reader still needs.
 */

import {Review} from './spaced_repetition';

/** Reviews a character needs before it may be considered known at all. */
export const MIN_REVIEWS_TO_PROMOTE = 3;

/** From this level up, the character renders WITHOUT its pinyin. */
export const KNOWN_LEVEL = 4;

/** The highest level a character with too few reviews may reach. */
const PROVISIONAL_CEILING = KNOWN_LEVEL - 1;

/** What the ledger and the renderer know about one character. */
export interface CharacterProgress {
  character: string;
  /** Reviews backing the level (own drills + sentence credit). */
  reviewCount: number;
  /** Mean score across those reviews, 0 when never reviewed. */
  averageScore: number;
  /** 0–5; `KNOWN_LEVEL`+ means the reading is hidden. */
  level: number;
}

/**
 * The level a set of reviews earns.
 *
 * Level is the rounded mean score, but a character with fewer than
 * `MIN_REVIEWS_TO_PROMOTE` reviews is capped below `KNOWN_LEVEL`: progress
 * stays visible (a character answered well twice shows level 3, not 0) while
 * promotion — the thing that removes the reading — waits for enough evidence.
 */
export function CharacterLevelFor(reviews: readonly Review[]): number {
  if (reviews.length === 0) return 0;
  const total = reviews.reduce((sum, review) => sum + review.difficulty, 0);
  const average = total / reviews.length;
  const level = Math.round(average);
  return reviews.length < MIN_REVIEWS_TO_PROMOTE
    ? Math.min(level, PROVISIONAL_CEILING)
    : level;
}

/** The full progress record for one character. */
export function ProgressFor(
  character: string,
  reviews: readonly Review[],
): CharacterProgress {
  const total = reviews.reduce((sum, review) => sum + review.difficulty, 0);
  return {
    character,
    reviewCount: reviews.length,
    averageScore: reviews.length === 0 ? 0 : total / reviews.length,
    level: CharacterLevelFor(reviews),
  };
}

/** Whether this level still needs its reading shown above the character. */
export function ShouldShowPinyin(level: number): boolean {
  return level < KNOWN_LEVEL;
}

/**
 * Whether adding one more review promotes a character across the
 * hide-the-pinyin line — the moment worth logging and counting, because it is
 * the moment the user's cards visibly change.
 */
export function CrossesKnownThreshold(
  before: readonly Review[],
  after: readonly Review[],
): boolean {
  return (
    CharacterLevelFor(before) < KNOWN_LEVEL &&
    CharacterLevelFor(after) >= KNOWN_LEVEL
  );
}
