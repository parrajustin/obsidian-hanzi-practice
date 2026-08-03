import {
  CharacterLevelFor,
  CrossesKnownThreshold,
  KNOWN_LEVEL,
  MIN_REVIEWS_TO_PROMOTE,
  ProgressFor,
  ShouldShowPinyin,
} from '../src/character_progress';
import {Review} from '../src/spaced_repetition';

const reviews = (...scores: number[]): Review[] =>
  scores.map((difficulty, i) => ({timestamp: 1000 + i, difficulty}));

describe('CharacterLevelFor', () => {
  it('is 0 for a character never reviewed', () => {
    expect(CharacterLevelFor([])).toBe(0);
  });

  it('is the rounded mean once there is enough evidence', () => {
    expect(CharacterLevelFor(reviews(5, 5, 5))).toBe(5);
    expect(CharacterLevelFor(reviews(4, 4, 4, 4))).toBe(4);
    expect(CharacterLevelFor(reviews(0, 3, 3))).toBe(2);
    expect(CharacterLevelFor(reviews(5, 4, 4, 0))).toBe(3);
  });

  it('CANNOT reach the known level before enough reviews', () => {
    // Two perfect answers are not proof; the reading must stay visible.
    expect(CharacterLevelFor(reviews(5, 5))).toBe(KNOWN_LEVEL - 1);
    expect(CharacterLevelFor(reviews(5))).toBe(KNOWN_LEVEL - 1);
    expect(reviews(5, 5).length).toBeLessThan(MIN_REVIEWS_TO_PROMOTE);
    // ...and the third one promotes it.
    expect(CharacterLevelFor(reviews(5, 5, 5))).toBeGreaterThanOrEqual(
      KNOWN_LEVEL,
    );
  });

  it('still shows partial progress below the ceiling', () => {
    expect(CharacterLevelFor(reviews(2))).toBe(2);
    expect(CharacterLevelFor(reviews(0, 0))).toBe(0);
  });

  it('demotes again when later answers are bad', () => {
    expect(CharacterLevelFor(reviews(5, 5, 5, 0, 0, 0))).toBeLessThan(
      KNOWN_LEVEL,
    );
  });
});

describe('ProgressFor', () => {
  it('reports the count, the mean and the level together', () => {
    expect(ProgressFor('好', reviews(5, 4, 3))).toEqual({
      character: '好',
      reviewCount: 3,
      averageScore: 4,
      level: 4,
    });
  });

  it('reports an unreviewed character as level 0 with no average', () => {
    expect(ProgressFor('车', [])).toEqual({
      character: '车',
      reviewCount: 0,
      averageScore: 0,
      level: 0,
    });
  });
});

describe('ShouldShowPinyin', () => {
  it.each([0, 1, 2, 3])('shows the reading at level %i', level => {
    expect(ShouldShowPinyin(level)).toBe(true);
  });

  it.each([4, 5])('hides the reading at level %i', level => {
    expect(ShouldShowPinyin(level)).toBe(false);
  });
});

describe('CrossesKnownThreshold', () => {
  it('is true exactly on the review that hides the reading', () => {
    expect(CrossesKnownThreshold(reviews(5, 5), reviews(5, 5, 5))).toBe(true);
  });

  it('is false when the level was already high, or is still low', () => {
    expect(CrossesKnownThreshold(reviews(5, 5, 5), reviews(5, 5, 5, 5))).toBe(
      false,
    );
    expect(CrossesKnownThreshold(reviews(1, 1), reviews(1, 1, 1))).toBe(false);
  });
});
