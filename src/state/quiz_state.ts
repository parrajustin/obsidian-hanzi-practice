export class QuizState {
  static calculateFinalScore(percentMistakes: number, totalMistakes: number, pinyinMistakes: number): number {
    let baseScore = 0;
    
    if (percentMistakes < 1e-6) {
      baseScore = 5;
    } else if (totalMistakes === 1) {
      baseScore = 4;
    } else if (percentMistakes < 0.25) {
      baseScore = 3;
    } else if (percentMistakes < 0.5) {
      baseScore = 2;
    } else if (percentMistakes < 0.75) {
      baseScore = 1;
    } else {
      baseScore = 0;
    }

    let maxDifficulty = 5;
    if (pinyinMistakes > 1) {
      maxDifficulty = 3;
    } else if (pinyinMistakes === 1) {
      maxDifficulty = 4;
    } else if (pinyinMistakes === 0) {
      maxDifficulty = 5;
    }

    return Math.min(baseScore, maxDifficulty);
  }
}
