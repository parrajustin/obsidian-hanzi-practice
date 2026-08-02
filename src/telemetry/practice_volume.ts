/**
 * Turns the review history into per-day counts, the input for the practice
 * volume metrics ("how many cards did I do that day").
 */

import {Review} from '../spaced_repetition';

/** LOCAL calendar day key (YYYY-MM-DD) — study days are a human concept. */
export function dayKey(ts: number): string {
  const date = new Date(ts);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** The day key `offset` days from `now` (0 = today, -1 = yesterday). */
export function dayKeyFor(offset: number, now = Date.now()): string {
  return dayKey(now + offset * 24 * 60 * 60 * 1000);
}

/**
 * Count reviews per local day across every entry in the history. One graded
 * card = one review line, so these counts are literally "cards done that day".
 */
export function countReviewsByDay(
  history: Record<string, Review[]>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const reviews of Object.values(history)) {
    for (const review of reviews) {
      const key = dayKey(review.timestamp);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}
