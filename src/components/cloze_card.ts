import {FLASHCARD_GRADES} from './flash_card';
import {parseClozeSegments} from '../utils/practice_list';

/**
 * Cloze (fill-in-the-blank) card: the sentence is shown with each `{{…}}`
 * answer replaced by a blank, plus an optional hint. The user recalls the
 * missing words, reveals the full sentence, then self-grades — the same
 * flip-and-self-grade idiom as `FlashCard` (typed answers would fight the
 * IME, especially on mobile).
 */
export class ClozeCard {
  private container: HTMLElement;
  private text: string;
  private hint: string;
  private onGrade: (score: number) => void;
  private graded = false;

  constructor(
    container: HTMLElement,
    text: string,
    hint: string,
    onGrade: (score: number) => void,
  ) {
    this.container = container;
    this.text = text;
    this.hint = hint;
    this.onGrade = onGrade;
  }

  render() {
    const card = this.container.createDiv({cls: 'cloze-card'});
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

    const segments = parseClozeSegments(this.text);

    // Prompt: literal text with each blanked answer rendered as underscores.
    const promptEl = card.createDiv({cls: 'cloze-prompt'});
    promptEl.style.fontSize = '1.4em';
    promptEl.style.textAlign = 'center';
    promptEl.style.whiteSpace = 'pre-wrap';
    for (const segment of segments) {
      if (segment.blank) {
        const blankEl = promptEl.createEl('span', {
          cls: 'cloze-blank',
          text: '____',
        });
        blankEl.style.textDecoration = 'underline';
        blankEl.style.letterSpacing = '2px';
      } else {
        promptEl.createEl('span', {text: segment.text});
      }
    }

    if (this.hint) {
      const hintEl = card.createDiv({cls: 'cloze-hint', text: this.hint});
      hintEl.style.textAlign = 'center';
      hintEl.style.color = 'var(--text-muted)';
    }

    // The answer (full sentence, blanked words accented) exists from the
    // start but stays hidden until the reveal, so revealing never reflows
    // the surrounding layout.
    const divider = card.createEl('hr', {cls: 'cloze-divider'});
    divider.style.display = 'none';
    divider.style.width = '100%';
    const answerEl = card.createDiv({cls: 'cloze-answer'});
    answerEl.style.display = 'none';
    answerEl.style.fontSize = '1.4em';
    answerEl.style.textAlign = 'center';
    answerEl.style.whiteSpace = 'pre-wrap';
    for (const segment of segments) {
      const segEl = answerEl.createEl('span', {text: segment.text});
      if (segment.blank) {
        segEl.addClass('cloze-answer-blank');
        segEl.style.color = 'var(--text-accent)';
        segEl.style.fontWeight = 'bold';
      }
    }

    const controls = this.container.createDiv({cls: 'cloze-controls'});
    const revealBtn = controls.createEl('button', {
      cls: 'cloze-reveal',
      text: 'Show Answer',
    });
    revealBtn.type = 'button';

    // Grade buttons appear only once the answer is visible — grading an
    // unseen answer would corrupt the schedule.
    const gradesEl = this.container.createDiv({cls: 'cloze-grades'});
    gradesEl.style.display = 'none';
    gradesEl.style.gap = '8px';
    gradesEl.style.flexWrap = 'wrap';
    for (const grade of FLASHCARD_GRADES) {
      const btn = gradesEl.createEl('button', {
        cls: 'cloze-grade',
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

    revealBtn.onclick = () => {
      divider.style.display = '';
      answerEl.style.display = '';
      revealBtn.style.display = 'none';
      gradesEl.style.display = 'flex';
    };
  }
}
