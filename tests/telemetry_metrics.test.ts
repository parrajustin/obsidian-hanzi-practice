import {
  ObserveCardsToday,
  RecordCardGraded,
  RecordCardsPerDay,
  ResetMetrics,
} from '../src/telemetry/metrics';
import {
  countReviewsByDay,
  dayKey,
  dayKeyFor,
} from '../src/telemetry/practice_volume';
import {InitTelemetry, ResetTelemetry} from '../src/telemetry/telemetry';

interface Recorded {
  instrument: string;
  value: number;
  attributes?: Record<string, unknown>;
}

function makeMeterCollector() {
  const recorded: Recorded[] = [];
  const created: string[] = [];
  const gaugeCallbacks: Array<
    (result: {observe: (v: number) => void}) => void
  > = [];
  const instrument = (name: string) => ({
    add: (value: number, attributes?: Record<string, unknown>) =>
      void recorded.push({instrument: name, value, attributes}),
    record: (value: number, attributes?: Record<string, unknown>) =>
      void recorded.push({instrument: name, value, attributes}),
  });
  const meter = {
    createCounter: (name: string) => {
      created.push(name);
      return instrument(name);
    },
    createHistogram: (name: string) => {
      created.push(name);
      return instrument(name);
    },
    createObservableGauge: (name: string) => {
      created.push(name);
      return {
        addCallback: (cb: (result: {observe: (v: number) => void}) => void) =>
          void gaugeCallbacks.push(cb),
      };
    },
  };
  const api = {
    apiVersion: 3,
    register: () => ({
      pluginId: 'hanzi-practice',
      pluginVersion: '1.0.0',
      getBaggage: () => ({}),
      setBaggage: () => {},
      log: () => {},
      getTracer: () => ({startActiveSpan: (_n: string, fn: never) => fn}),
      getMeter: () => meter,
      start: () => {},
      restart: () => {},
      end: () => {},
      startGroup: () => '',
      endGroup: () => undefined,
    }),
  };
  return {api, recorded, created, gaugeCallbacks};
}

describe('practice volume helpers', () => {
  it('keys reviews by LOCAL calendar day', () => {
    const noon = new Date(2026, 0, 15, 12, 0, 0).getTime();
    expect(dayKey(noon)).toBe('2026-01-15');
    expect(dayKeyFor(-1, noon)).toBe('2026-01-14');
    expect(dayKeyFor(0, noon)).toBe('2026-01-15');
  });

  it('counts reviews per day across every entry', () => {
    const day1 = new Date(2026, 0, 15, 9, 0, 0).getTime();
    const day1Later = new Date(2026, 0, 15, 21, 0, 0).getTime();
    const day2 = new Date(2026, 0, 16, 9, 0, 0).getTime();
    const counts = countReviewsByDay({
      a1b2c3d4: [
        {timestamp: day1, difficulty: 5},
        {timestamp: day2, difficulty: 3},
      ],
      e5f6a7b8: [{timestamp: day1Later, difficulty: 4}],
    });
    expect(counts.get('2026-01-15')).toBe(2);
    expect(counts.get('2026-01-16')).toBe(1);
  });

  it('handles an empty history', () => {
    expect(countReviewsByDay({}).size).toBe(0);
  });
});

describe('practice metrics', () => {
  let fake: ReturnType<typeof makeMeterCollector>;

  beforeEach(() => {
    ResetTelemetry();
    ResetMetrics();
    fake = makeMeterCollector();
    window.bugCollector = fake.api as never;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    InitTelemetry('1.0.0');
  });

  afterEach(() => {
    ResetMetrics();
    ResetTelemetry();
    delete window.bugCollector;
    jest.restoreAllMocks();
  });

  it('records a graded card as a count, a score and a duration', () => {
    RecordCardGraded({cardType: '0', bank: 'Hanzi'}, 5, 4200);
    expect(fake.recorded).toEqual([
      {
        instrument: 'hanzi.cards_graded',
        value: 1,
        attributes: {cardType: '0', bank: 'Hanzi', outcome: 'pass'},
      },
      {
        instrument: 'hanzi.card_score',
        value: 5,
        attributes: {cardType: '0'},
      },
      {
        instrument: 'hanzi.card_duration',
        value: 4200,
        attributes: {cardType: '0'},
      },
    ]);
  });

  it('labels a sub-passing grade as a failure', () => {
    RecordCardGraded({cardType: '3', bank: 'Capitals'}, 0);
    expect(fake.recorded[0]!.attributes).toEqual({
      cardType: '3',
      bank: 'Capitals',
      outcome: 'fail',
    });
    // No duration was supplied, so no duration sample.
    expect(fake.recorded.map(r => r.instrument)).not.toContain(
      'hanzi.card_duration',
    );
  });

  it('creates each instrument only once across many grades', () => {
    RecordCardGraded({cardType: '0', bank: 'Hanzi'}, 4);
    RecordCardGraded({cardType: '0', bank: 'Hanzi'}, 2);
    expect(
      fake.created.filter(name => name === 'hanzi.cards_graded'),
    ).toHaveLength(1);
  });

  it('records a completed day into the volume histogram', () => {
    RecordCardsPerDay(17);
    expect(fake.recorded).toEqual([
      {instrument: 'hanzi.cards_per_day', value: 17, attributes: undefined},
    ]);
  });

  it('samples the observable gauge through the provider', () => {
    let today = 3;
    ObserveCardsToday(() => today);
    expect(fake.created).toContain('hanzi.cards_graded_today');

    const observed: number[] = [];
    const result = {observe: (v: number) => void observed.push(v)};
    fake.gaugeCallbacks[0]!(result);
    today = 8;
    fake.gaugeCallbacks[0]!(result);
    expect(observed).toEqual([3, 8]);
  });

  it('a throwing provider does not break collection', () => {
    ObserveCardsToday(() => {
      throw new Error('history unreadable');
    });
    const observed: number[] = [];
    expect(() =>
      fake.gaugeCallbacks[0]!({observe: v => void observed.push(v)}),
    ).not.toThrow();
    expect(observed).toEqual([]);
  });
});

describe('practice metrics without a collector', () => {
  beforeEach(() => {
    ResetTelemetry();
    ResetMetrics();
    delete window.bugCollector;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    ResetMetrics();
    ResetTelemetry();
    jest.restoreAllMocks();
  });

  it('every recorder is a silent no-op', () => {
    expect(() => {
      RecordCardGraded({cardType: '0', bank: 'Hanzi'}, 5, 100);
      RecordCardsPerDay(4);
      ObserveCardsToday(() => 1);
    }).not.toThrow();
  });
});
