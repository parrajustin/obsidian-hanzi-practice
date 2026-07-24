/**
 * DOM tests for the four practice-card components. Obsidian's Element
 * helpers (`createDiv` etc.) are shimmed by tests/setup_obsidian_dom.ts.
 */
import {FlashCard, FLASHCARD_GRADES} from '../src/components/flash_card';
import {MultiChoiceCard} from '../src/components/multi_choice_card';
import {ClozeCard} from '../src/components/cloze_card';
import {PinyinSelector} from '../src/components/pinyin_selector';

function texts(root: HTMLElement, selector: string): (string | null)[] {
  return Array.from(root.querySelectorAll(selector)).map(el => el.textContent);
}

function click(el: Element | null) {
  (el as HTMLElement).dispatchEvent(new MouseEvent('click'));
}

describe('FlashCard', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
  });

  it('hides the back and grades until flipped', () => {
    new FlashCard(container, 'France', 'Paris', jest.fn()).render();
    expect(container.querySelector('.flash-card-front')?.textContent).toBe(
      'France',
    );
    const back = container.querySelector('.flash-card-back') as HTMLElement;
    const grades = container.querySelector('.flash-card-grades') as HTMLElement;
    expect(back.style.display).toBe('none');
    expect(grades.style.display).toBe('none');

    click(container.querySelector('.flash-card-flip'));
    expect(back.style.display).toBe('');
    expect(grades.style.display).toBe('flex');
    expect(texts(container, '.flash-card-grade')).toEqual(
      FLASHCARD_GRADES.map(g => g.label),
    );
  });

  it('reports the picked grade score exactly once', () => {
    const onGrade = jest.fn();
    new FlashCard(container, 'F', 'B', onGrade).render();
    click(container.querySelector('.flash-card-flip'));
    const buttons = container.querySelectorAll('.flash-card-grade');
    click(buttons[1]); // Easy = 4
    click(buttons[0]); // second grade must be ignored
    expect(onGrade).toHaveBeenCalledTimes(1);
    expect(onGrade).toHaveBeenCalledWith(4);
  });
});

describe('MultiChoiceCard', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
  });

  const render = (onComplete: (mistakes: number) => void) => {
    new MultiChoiceCard(
      container,
      '你__狗吗？',
      '有没有',
      ['不有', '没不有'],
      onComplete,
    ).render();
  };

  const option = (text: string) =>
    Array.from(container.querySelectorAll('.mc-option')).find(
      b => b.textContent === text,
    ) as HTMLButtonElement;

  it('renders the question and all options', () => {
    render(jest.fn());
    expect(container.querySelector('.mc-question')?.textContent).toBe(
      '你__狗吗？',
    );
    expect(texts(container, '.mc-option').sort()).toEqual(
      ['有没有', '不有', '没不有'].sort(),
    );
  });

  it('completes with 0 mistakes on an immediate correct pick', () => {
    const onComplete = jest.fn();
    render(onComplete);
    click(option('有没有'));
    expect(onComplete).toHaveBeenCalledWith(0);
    // Every button is disabled after completion.
    container
      .querySelectorAll('.mc-option')
      .forEach(b => expect((b as HTMLButtonElement).disabled).toBe(true));
  });

  it('marks and counts wrong picks without completing', () => {
    const onComplete = jest.fn();
    render(onComplete);
    click(option('不有'));
    expect(onComplete).not.toHaveBeenCalled();
    expect(option('不有').disabled).toBe(true);
    expect(option('不有').style.border).toContain('red');

    click(option('没不有'));
    click(option('有没有'));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(2);
  });

  it('ignores clicks after completion', () => {
    const onComplete = jest.fn();
    render(onComplete);
    click(option('有没有'));
    click(option('有没有'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('ClozeCard', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
  });

  it('renders the blanked prompt with the hint, hiding the answer', () => {
    new ClozeCard(
      container,
      '我一个星期{{没}}吃饭。',
      "I haven't eaten for a week.",
      jest.fn(),
    ).render();
    const prompt = container.querySelector('.cloze-prompt') as HTMLElement;
    expect(prompt.textContent).toBe('我一个星期____吃饭。');
    expect(container.querySelector('.cloze-hint')?.textContent).toBe(
      "I haven't eaten for a week.",
    );
    const answer = container.querySelector('.cloze-answer') as HTMLElement;
    expect(answer.style.display).toBe('none');
    expect(
      (container.querySelector('.cloze-grades') as HTMLElement).style.display,
    ).toBe('none');
  });

  it('omits the hint element when there is no hint', () => {
    new ClozeCard(container, '四{{个}}月', '', jest.fn()).render();
    expect(container.querySelector('.cloze-hint')).toBeNull();
  });

  it('reveals the full sentence with accented blanks, then self-grades once', () => {
    const onGrade = jest.fn();
    new ClozeCard(
      container,
      '{{如果}}你有时间，{{就}}来',
      'hint',
      onGrade,
    ).render();
    const prompt = container.querySelector('.cloze-prompt') as HTMLElement;
    expect(prompt.textContent).toBe('____你有时间，____来');

    click(container.querySelector('.cloze-reveal'));
    const answer = container.querySelector('.cloze-answer') as HTMLElement;
    expect(answer.style.display).toBe('');
    expect(answer.textContent).toBe('如果你有时间，就来');
    expect(texts(container, '.cloze-answer-blank')).toEqual(['如果', '就']);

    const grades = container.querySelectorAll('.cloze-grade');
    expect(grades).toHaveLength(FLASHCARD_GRADES.length);
    click(grades[2]); // Hard = 3
    click(grades[0]); // ignored — one grade per card
    expect(onGrade).toHaveBeenCalledTimes(1);
    expect(onGrade).toHaveBeenCalledWith(3);
  });
});

describe('PinyinSelector', () => {
  let container: HTMLElement;
  beforeEach(() => {
    container = document.createElement('div');
  });

  const button = (text: string) =>
    Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === text,
    ) as HTMLButtonElement;

  it('renders the correct pinyin plus its four distractor tones', () => {
    new PinyinSelector(container, 'hao3', jest.fn()).render();
    const options = texts(container, 'button').sort();
    expect(options).toEqual(['hao', 'hào', 'hāo', 'háo', 'hǎo'].sort());
  });

  it('counts wrong picks and completes on the correct one', () => {
    const onComplete = jest.fn();
    new PinyinSelector(container, 'hao3', onComplete).render();
    click(button('hāo'));
    expect(onComplete).not.toHaveBeenCalled();
    click(button('hǎo'));
    expect(onComplete).toHaveBeenCalledWith(1);
    // Clicks after completion are ignored.
    click(button('háo'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
