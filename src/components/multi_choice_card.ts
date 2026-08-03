/** Optional extras used by card types that reuse this component. */
export interface MultiChoiceCardOptions {
  /** Small muted line above the question, e.g. "Is this correct?". */
  prompt?: string;
  /**
   * Wrong-answer correction text, revealed the moment a wrong pick happens
   * (and kept visible). A clean run never shows it.
   */
  explanation?: string;
  /**
   * Told about EVERY pick (not just the completing one), so the view can log
   * which options were tried before the right one.
   */
  onPick?: (pick: {option: string; correct: boolean; mistakes: number}) => void;
}

/**
 * Multiple-choice card: the question is shown with the correct answer and
 * its distractors as shuffled buttons. Wrong picks are marked and counted;
 * the card completes on the correct pick and reports the mistake count —
 * grading is automatic (see the view's mistake→score mapping), never
 * self-graded. Same interaction model as `PinyinSelector`.
 *
 * Also renders true/false cards ("Is this correct?" prompt + the statement
 * as the question + Correct/Incorrect as the two options) — the `options`
 * extras exist for that reuse rather than a near-identical component.
 */
export class MultiChoiceCard {
  private container: HTMLElement;
  private question: string;
  private answer: string;
  private distractors: string[];
  private onComplete: (mistakes: number) => void;
  private options: MultiChoiceCardOptions;
  private mistakes = 0;
  private buttons: HTMLButtonElement[] = [];
  private completed = false;

  constructor(
    container: HTMLElement,
    question: string,
    answer: string,
    distractors: string[],
    onComplete: (mistakes: number) => void,
    options: MultiChoiceCardOptions = {},
  ) {
    this.container = container;
    this.question = question;
    this.answer = answer;
    this.distractors = distractors;
    this.onComplete = onComplete;
    this.options = options;
  }

  render() {
    const card = this.container.createDiv({cls: 'mc-card'});
    card.style.border = '1px solid var(--background-modifier-border)';
    card.style.borderRadius = '8px';
    card.style.padding = '24px';
    card.style.margin = '20px 0';
    card.style.maxWidth = '480px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '16px';

    if (this.options.prompt) {
      const promptEl = card.createDiv({
        cls: 'mc-prompt',
        text: this.options.prompt,
      });
      promptEl.style.textAlign = 'center';
      promptEl.style.color = 'var(--text-muted)';
    }

    const questionEl = card.createDiv({
      cls: 'mc-question',
      text: this.question,
    });
    questionEl.style.fontSize = '1.4em';
    questionEl.style.textAlign = 'center';
    questionEl.style.whiteSpace = 'pre-wrap';

    const options = [this.answer, ...this.distractors];
    // Fisher-Yates shuffle
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }

    const optionsEl = card.createDiv({cls: 'mc-options'});
    optionsEl.style.display = 'flex';
    optionsEl.style.gap = '8px';
    optionsEl.style.flexWrap = 'wrap';
    optionsEl.style.justifyContent = 'center';

    // Hidden until a wrong pick happens: the correction/why.
    let explanationEl: HTMLElement | null = null;
    if (this.options.explanation) {
      explanationEl = card.createDiv({
        cls: 'mc-explanation',
        text: this.options.explanation,
      });
      explanationEl.style.textAlign = 'center';
      explanationEl.style.color = 'var(--text-muted)';
      explanationEl.style.whiteSpace = 'pre-wrap';
      explanationEl.style.display = 'none';
    }

    for (const option of options) {
      const btn = optionsEl.createEl('button', {
        cls: 'mc-option',
        text: option,
      });
      btn.type = 'button';
      this.buttons.push(btn);

      btn.onclick = () => {
        if (this.completed) return;

        if (option === this.answer) {
          btn.style.backgroundColor = '#4caf50';
          btn.style.color = 'white';
          this.completed = true;
          this.buttons.forEach(b => {
            b.disabled = true;
            if (b !== btn) b.style.opacity = '0.5';
          });
          this.options.onPick?.({
            option,
            correct: true,
            mistakes: this.mistakes,
          });
          this.onComplete(this.mistakes);
        } else {
          btn.style.border = '5px solid red';
          btn.disabled = true;
          btn.style.opacity = '0.5';
          this.mistakes++;
          if (explanationEl) explanationEl.style.display = 'block';
          this.options.onPick?.({
            option,
            correct: false,
            mistakes: this.mistakes,
          });
        }
      };
    }
  }
}
