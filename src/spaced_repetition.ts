export interface Review {
  timestamp: number; // Date.now() timestamp
  difficulty: number; // 0-5
}

export class SpacedRepetition {
  static readonly DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

  static getCurrentDayNumber(): number {
    return Math.floor(Date.now() / this.DAY_IN_MILLISECONDS);
  }

  static getDayNumber(timestamp: number): number {
    return Math.floor(timestamp / this.DAY_IN_MILLISECONDS);
  }

  /**
   * Calculates the next due day number for a flashcard based on its past reviews.
   * @param reviews An array of past reviews, assumed to be sorted chronologically (oldest first).
   * @returns The due day number.
   */
  static calculateDueDayNumber(reviews: Review[]): number {
    const today = this.getCurrentDayNumber();

    if (reviews.length === 0) {
      return today - 1; // Brand new cards forced to yesterday so they are strictly due
    }

    const lastReview = reviews[reviews.length - 1];
    const lastReviewDay = this.getDayNumber(lastReview.timestamp);

    // If failing, it's due today
    if (lastReview.difficulty < 3) {
      return today;
    }

    // Passing
    if (reviews.length === 1) {
      return lastReviewDay + 1;
    }

    if (reviews.length === 2) {
      return lastReviewDay + 6;
    }

    let efactor = 2.5;
    reviews.forEach((review) => {
      efactor += +(0.1 - (5 - review.difficulty) * (0.08 + (5 - review.difficulty) * 0.02));
    });

    if (efactor < 1.3) {
      efactor = 1.3;
    }

    return lastReviewDay + Math.ceil(reviews.length * efactor);
  }
}
