/**
 * Practice metrics, recorded through the Bug Collector's meter.
 *
 * Instruments are created lazily on first use and cached, so a collector that
 * shows up late (or never) costs nothing. Every helper is a no-op without a
 * collector — never a throw, never a console write (that is telemetry.ts's
 * failsafe job).
 */

import type {Counter, Histogram, ObservableGauge} from '@opentelemetry/api';
import {None, Optional, Some} from 'standard-ts-lib/src/optional';
import {WrapToResult} from 'standard-ts-lib/src/wrap_to_result';
import {GetTelemetry} from './telemetry';

/**
 * Bucket boundaries for "cards practiced in a day". The SDK default buckets
 * (0,5,10,25,50,…,10000) are tuned for milliseconds and would put every
 * realistic study day in the first two buckets; these match how many cards a
 * person actually reviews per day.
 */
const CARDS_PER_DAY_BUCKETS = [1, 5, 10, 20, 30, 50, 75, 100, 150, 200];

interface Instruments {
  cardsGraded: Counter;
  cardScore: Histogram;
  cardDuration: Histogram;
  cardsPerDay: Histogram;
  charactersCredited: Counter;
  characterLevelUps: Counter;
  charactersKnown: Histogram;
  noIdea: Counter;
}

let instruments: Optional<Instruments> = None;
/** Set by the plugin so the observable gauge can sample today's total. */
let cardsTodayProvider: Optional<() => number> = None;
let gauge: Optional<ObservableGauge> = None;

/** Build (once) the instruments, if a collector is available. */
function getInstruments(): Optional<Instruments> {
  if (instruments.some) return instruments;
  const telemetry = GetTelemetry();
  if (telemetry.none) return None;
  const built = WrapToResult(() => {
    const meter = telemetry.safeValue().getMeter();
    return {
      cardsGraded: meter.createCounter('hanzi.cards_graded', {
        description: 'Practice cards graded',
        unit: 'cards',
      }),
      cardScore: meter.createHistogram('hanzi.card_score', {
        description: 'Distribution of spaced-repetition grades (0-5)',
        unit: 'score',
      }),
      cardDuration: meter.createHistogram('hanzi.card_duration', {
        description: 'Time from a card being shown to it being graded',
        unit: 'ms',
      }),
      cardsPerDay: meter.createHistogram('hanzi.cards_per_day', {
        description: 'Cards practiced in a day, sampled at each session start',
        unit: 'cards',
        advice: {explicitBucketBoundaries: CARDS_PER_DAY_BUCKETS},
      }),
      charactersCredited: meter.createCounter('hanzi.characters_credited', {
        description:
          'Characters credited with a score because a card containing them ' +
          'was graded',
        unit: 'characters',
      }),
      characterLevelUps: meter.createCounter('hanzi.character_level_ups', {
        description:
          'Characters that crossed the known threshold, so their pinyin is ' +
          'no longer printed on cards',
        unit: 'characters',
      }),
      charactersKnown: meter.createHistogram('hanzi.characters_known', {
        description:
          'Characters at or above the known level, sampled when a card loads',
        unit: 'characters',
      }),
      noIdea: meter.createCounter('hanzi.no_idea', {
        description: 'Cards ended with "No Idea" instead of a guess',
        unit: 'cards',
      }),
    };
  }, /*textForUnknown=*/ 'Failed to create metric instruments');
  if (built.err) return None;
  instruments = Some(built.safeUnwrap());
  return instruments;
}

/** Reset cached instruments (plugin unload / tests). */
export function ResetMetrics(): void {
  instruments = None;
  cardsTodayProvider = None;
  gauge = None;
}

export interface GradedCardAttributes {
  /** Numeric CardType (0 hanzi, 1 flashcard, … ) as a label. */
  cardType: string;
  bank: string;
}

/**
 * Record one graded card: the count, its grade distribution, and how long the
 * user spent on it. `score` is the SR grade (0-5); <3 counts as a failure.
 */
export function RecordCardGraded(
  attributes: GradedCardAttributes,
  score: number,
  durationMs?: number,
): void {
  const built = getInstruments();
  if (built.none) return;
  const labels = {
    ...attributes,
    outcome: score >= 3 ? 'pass' : 'fail',
  };
  const metrics = built.safeValue();
  metrics.cardsGraded.add(1, labels);
  metrics.cardScore.record(score, {cardType: attributes.cardType});
  if (durationMs !== undefined && durationMs >= 0) {
    metrics.cardDuration.record(durationMs, {cardType: attributes.cardType});
  }
}

/**
 * Record how many cards were practiced on a completed day. Called at session
 * start for days that ended since the last session, so each day contributes
 * exactly one observation to the histogram.
 */
export function RecordCardsPerDay(count: number): void {
  const built = getInstruments();
  if (built.none) return;
  built.safeValue().cardsPerDay.record(count);
}

/**
 * Characters credited by one graded card (0 when the card has no tracked
 * characters). The counter answers "is sentence practice actually moving the
 * character levels, or only the card schedule?".
 */
export function RecordCharactersCredited(
  cardType: string,
  count: number,
): void {
  if (count <= 0) return;
  const built = getInstruments();
  if (built.none) return;
  built.safeValue().charactersCredited.add(count, {card_type: cardType});
}

/** One character crossed the known threshold — its readings stop printing. */
export function RecordCharacterLevelUp(character: string): void {
  const built = getInstruments();
  if (built.none) return;
  built.safeValue().characterLevelUps.add(1, {character});
}

/** How much of the tracked set is known, sampled whenever a card loads. */
export function RecordCharactersKnown(known: number, tracked: number): void {
  const built = getInstruments();
  if (built.none) return;
  built.safeValue().charactersKnown.record(known, {tracked});
}

/** A card the user declined to guess at. */
export function RecordNoIdea(cardType: string, bank: string): void {
  const built = getInstruments();
  if (built.none) return;
  built.safeValue().noIdea.add(1, {card_type: cardType, bank});
}

/**
 * Publish an observable gauge for "cards graded today", sampled by the SDK on
 * every metric collection. `provider` must be cheap and synchronous — it runs
 * inside the export cycle.
 */
export function ObserveCardsToday(provider: () => number): void {
  const telemetry = GetTelemetry();
  if (telemetry.none || gauge.some) return;
  const created = WrapToResult(() => {
    const observable = telemetry
      .safeValue()
      .getMeter()
      .createObservableGauge('hanzi.cards_graded_today', {
        description: 'Cards graded so far on the current (local) day',
        unit: 'cards',
      });
    observable.addCallback(result => {
      const current = cardsTodayProvider;
      if (current.none) return;
      // Bind before the closure: narrowing does not survive into it.
      const sample = current.safeValue();
      const sampled = WrapToResult(
        () => sample(),
        /*textForUnknown=*/ 'cards-today provider failed',
      );
      if (sampled.ok) result.observe(sampled.safeUnwrap());
    });
    return observable;
  }, /*textForUnknown=*/ 'Failed to create observable gauge');
  if (created.err) return;
  cardsTodayProvider = Some(provider);
  gauge = Some(created.safeUnwrap());
}
