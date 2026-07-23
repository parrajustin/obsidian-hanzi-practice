/**
 * Self-graded flashcard: the prompt side is shown, the user recalls the
 * answer, flips the card, then grades their own recall. The grade feeds the
 * same SM-2-style scheduler as the hanzi quiz (0–5; <3 counts as a fail and
 * the card comes back today).
 */
export interface FlashcardGrade {
  label: string;
  score: number;
}

export const FLASHCARD_GRADES: FlashcardGrade[] = [
  {label: 'Very Easy', score: 5},
  {label: 'Easy', score: 4},
  {label: 'Hard', score: 3},
  {label: 'Very Hard', score: 2},
  {label: 'No Idea', score: 0},
];

export class FlashCard {
  private container: HTMLElement;
  private front: string;
  private back: string;
  private onGrade: (score: number) => void;
  private graded = false;

  constructor(
    container: HTMLElement,
    front: string,
    back: string,
    onGrade: (score: number) => void,
  ) {
    this.container = container;
    this.front = front;
    this.back = back;
    this.onGrade = onGrade;
  }

  render() {
    const card = this.container.createDiv({cls: 'flash-card'});
    card.style.border = '1px solid var(--background-modifier-border)';
    card.style.borderRadius = '8px';
    card.style.padding = '24px';
    card.style.margin = '20px 0';
    card.style.maxWidth = '480px';
    card.style.minHeight = '120px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.justifyContent = 'center';
    card.style.gap = '16px';

    const frontEl = card.createDiv({cls: 'flash-card-front', text: this.front});
    frontEl.style.fontSize = '1.4em';
    frontEl.style.textAlign = 'center';
    frontEl.style.whiteSpace = 'pre-wrap';

    // The answer side exists from the start but is hidden until the flip, so
    // flipping never reflows the surrounding layout.
    const divider = card.createEl('hr', {cls: 'flash-card-divider'});
    divider.style.display = 'none';
    divider.style.width = '100%';
    const backEl = card.createDiv({cls: 'flash-card-back', text: this.back});
    backEl.style.display = 'none';
    backEl.style.fontSize = '1.2em';
    backEl.style.textAlign = 'center';
    backEl.style.whiteSpace = 'pre-wrap';
    backEl.style.color = 'var(--text-accent)';

    const controls = this.container.createDiv({cls: 'flash-card-controls'});
    const flipBtn = controls.createEl('button', {
      cls: 'flash-card-flip',
      text: 'Show Answer',
    });
    flipBtn.type = 'button';

    // Grade buttons appear only once the answer is visible — grading an
    // unseen answer would corrupt the schedule.
    const gradesEl = this.container.createDiv({cls: 'flash-card-grades'});
    gradesEl.style.display = 'none';
    gradesEl.style.gap = '8px';
    gradesEl.style.flexWrap = 'wrap';
    for (const grade of FLASHCARD_GRADES) {
      const btn = gradesEl.createEl('button', {
        cls: 'flash-card-grade',
        text: grade.label,
      });
      btn.type = 'button';
      btn.dataset.score = String(grade.score);
      btn.onclick = () => {
        if (this.graded) return; // one grade per card
        this.graded = true;
        this.onGrade(grade.score);
      };
    }

    flipBtn.onclick = () => {
      divider.style.display = '';
      backEl.style.display = '';
      flipBtn.style.display = 'none';
      gradesEl.style.display = 'flex';
    };
  }
}
