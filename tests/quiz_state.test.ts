import {QuizState} from '../src/state/quiz_state';

describe('QuizState.calculateFinalScore', () => {
  it('maps stroke-mistake ratios to the 0–5 base score', () => {
    expect(QuizState.calculateFinalScore(0, 0, 0)).toBe(5);
    expect(QuizState.calculateFinalScore(0.1, 1, 0)).toBe(4); // exactly one miss
    expect(QuizState.calculateFinalScore(0.2, 2, 0)).toBe(3);
    expect(QuizState.calculateFinalScore(0.4, 4, 0)).toBe(2);
    expect(QuizState.calculateFinalScore(0.6, 6, 0)).toBe(1);
    expect(QuizState.calculateFinalScore(0.9, 9, 0)).toBe(0);
  });

  it('caps the score by pinyin mistakes', () => {
    expect(QuizState.calculateFinalScore(0, 0, 1)).toBe(4);
    expect(QuizState.calculateFinalScore(0, 0, 2)).toBe(3);
    // The cap never raises a low base score.
    expect(QuizState.calculateFinalScore(0.6, 6, 2)).toBe(1);
  });
});
