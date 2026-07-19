import {SpacedRepetition} from '../src/spaced_repetition';

describe('SpacedRepetition Engine', () => {
  const ONE_DAY = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    // Mock Date.now to a fixed point in time
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-07-19T12:00:00Z').getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should force immediate review for brand new cards', () => {
    const today = SpacedRepetition.getCurrentDayNumber();
    const dueDay = SpacedRepetition.calculateDueDayNumber([]);

    expect(dueDay).toBeLessThan(today);
  });

  it('should schedule next day for the first passing review', () => {
    const today = SpacedRepetition.getCurrentDayNumber();
    const lastReview = {timestamp: Date.now(), difficulty: 3};
    const dueDay = SpacedRepetition.calculateDueDayNumber([lastReview]);

    expect(dueDay).toBe(today + 1);
  });

  it('should schedule 6 days later for the second passing review', () => {
    const today = SpacedRepetition.getCurrentDayNumber();
    const review1 = {timestamp: Date.now() - ONE_DAY, difficulty: 4};
    const review2 = {timestamp: Date.now(), difficulty: 4};

    const dueDay = SpacedRepetition.calculateDueDayNumber([review1, review2]);
    expect(dueDay).toBe(today + 6);
  });

  it('should force review today if the last review was failing (score < 3)', () => {
    const today = SpacedRepetition.getCurrentDayNumber();
    const review1 = {timestamp: Date.now() - ONE_DAY * 10, difficulty: 4};
    const review2 = {timestamp: Date.now(), difficulty: 2}; // Failed

    const dueDay = SpacedRepetition.calculateDueDayNumber([review1, review2]);
    expect(dueDay).toBe(today);
  });

  it('should calculate exponential factor for 3+ reviews', () => {
    const today = SpacedRepetition.getCurrentDayNumber();
    const reviews = [
      {timestamp: Date.now() - ONE_DAY * 10, difficulty: 4},
      {timestamp: Date.now() - ONE_DAY * 5, difficulty: 4},
      {timestamp: Date.now(), difficulty: 5}, // Perfect score on 3rd review
    ];

    const dueDay = SpacedRepetition.calculateDueDayNumber(reviews);
    // Base efactor 2.5 + adjustments
    // Review 1 (4): 2.5 + (0.1 - (1) * (0.08 + 1 * 0.02)) = 2.5
    // Review 2 (4): 2.5 + 0 = 2.5
    // Review 3 (5): 2.5 + (0.1 - 0) = 2.6
    // E-factor = 2.6
    // Interval = Math.ceil(3 * 2.6) = Math.ceil(7.8) = 8

    expect(dueDay).toBe(today + 8);
  });
});
