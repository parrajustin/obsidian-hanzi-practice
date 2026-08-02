import {App, WorkspaceLeaf} from 'obsidian';
// Mock-only export — same module instance as 'obsidian' under jest's mapper.
import {noticeMessages} from './__mocks__/obsidian';
import {Err} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {HanziPracticeView} from '../src/views/hanzi_view';
import {HistoryManager} from '../src/utils/history_manager';
import {CardType, PracticeEntry} from '../src/utils/practice_list';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const FLASH: PracticeEntry = {
  id: 'aaaaaaaa',
  cardType: CardType.FLASHCARD,
  bank: 'Capitals',
  front: 'France',
  back: 'Paris',
};
const REVERSIBLE: PracticeEntry = {
  id: 'eeeeeeee',
  cardType: CardType.REVERSIBLE_FLASHCARD,
  bank: 'German',
  front: 'dog',
  back: 'Hund',
};
const MC: PracticeEntry = {
  id: 'bbbbbbbb',
  cardType: CardType.MULTIPLE_CHOICE,
  bank: 'Grammar',
  question: '你__狗吗？',
  answer: '有没有',
  distractors: ['不有'],
};
const CLOZE: PracticeEntry = {
  id: 'cccccccc',
  cardType: CardType.CLOZE,
  bank: 'Grammar',
  text: '四{{个}}月',
  hint: 'four months',
};
const TRUE_FALSE: PracticeEntry = {
  id: 'ffffffff',
  cardType: CardType.TRUE_FALSE,
  bank: 'Grammar',
  statement: '你有没有一只狗吗？',
  isCorrect: false,
  explanation: '有没有 already forms the question — drop the 吗.',
};
const HANZI: PracticeEntry = {
  id: 'dddddddd',
  cardType: CardType.HANZI,
  bank: 'Hanzi',
  character: '好',
  pinyin: 'hao3',
  english: 'good',
};

describe('HanziPracticeView', () => {
  let view: HanziPracticeView;
  let nextDue: jest.SpyInstance;
  let appendResult: jest.SpyInstance;

  // Restore Math.random and the HistoryManager spies between tests.
  afterEach(() => jest.restoreAllMocks());

  const makeView = () => {
    const plugin = {
      app: new App(),
      settings: {
        version: 2,
        historyFilePath: 'history.md',
        practiceFilePath: 'words.md',
        banks: [],
        dataPacks: [],
      },
      // No stroke database in unit tests — the view must degrade to the
      // .hanzi-no-stroke-data message instead of constructing a quiz writer.
      getStrokeData: jest
        .fn()
        .mockResolvedValue(Err(NotFoundError('no stroke db in tests'))),
      // Telemetry bookkeeping the view kicks off after each grade.
      refreshReviewCounts: jest.fn().mockResolvedValue(undefined),
    } as never;
    view = new HanziPracticeView(new WorkspaceLeaf() as never, plugin);
    return view;
  };

  const content = () => view.containerEl.children[1] as HTMLElement;

  const openWith = async (entry: PracticeEntry | null, bank?: string) => {
    nextDue = jest
      .spyOn(HistoryManager, 'getNextDueEntry')
      .mockResolvedValue(entry);
    appendResult = jest
      .spyOn(HistoryManager, 'appendResult')
      .mockResolvedValue(undefined);
    makeView();
    if (bank) await view.setState({bank}, {} as never);
    await view.onOpen();
  };

  it('renders a flashcard and advances after self-grading', async () => {
    await openWith(FLASH, 'Capitals');
    expect(view.getDisplayText()).toBe('Practice: Capitals');
    expect(view.getState()).toEqual({bank: 'Capitals'});
    expect(content().querySelector('.flash-card-front')?.textContent).toBe(
      'France',
    );

    (content().querySelector('.flash-card-flip') as HTMLElement).dispatchEvent(
      new MouseEvent('click'),
    );
    const easy = Array.from(
      content().querySelectorAll('.flash-card-grade'),
    ).find(b => (b as HTMLElement).dataset.score === '4');
    (easy as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(appendResult).toHaveBeenCalledWith(
      expect.anything(),
      'history.md',
      FLASH,
      4,
    );
    expect(nextDue).toHaveBeenCalledTimes(2); // onOpen + post-grade advance
  });

  it('a plain (type 1) flashcard ALWAYS prompts with its front', async () => {
    // Regression for a real vault line (`快⇥kuài — fast⇥⇥⇥1⇥L2 Words`):
    // a non-reversible card must never show its definition side first, no
    // matter what Math.random returns (the reversible coin flip must be
    // gated on the card type).
    const {parsePracticeList} = jest.requireActual<
      typeof import('../src/utils/practice_list')
    >('../src/utils/practice_list');
    const [entry] = parsePracticeList('快\tkuài — fast\t\t\t1\tL2 Words');
    expect(entry.cardType).toBe(CardType.FLASHCARD);

    for (const roll of [0, 0.25, 0.4999, 0.75, 0.999]) {
      jest.spyOn(Math, 'random').mockReturnValue(roll);
      await openWith(entry, 'L2 Words');
      expect(content().querySelector('.flash-card-front')?.textContent).toBe(
        '快',
      );
      const back = content().querySelector('.flash-card-back') as HTMLElement;
      expect(back.textContent).toBe('kuài — fast');
      expect(back.style.display).toBe('none'); // hidden until flipped
      jest.restoreAllMocks();
    }
  });

  it('may prompt a reversible flashcard with its back side', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.1); // force reversed
    await openWith(REVERSIBLE, 'German');
    expect(content().querySelector('.flash-card-front')?.textContent).toBe(
      'Hund',
    );
    expect(content().querySelector('.flash-card-back')?.textContent).toBe(
      'dog',
    );
  });

  it('renders a multiple-choice card and auto-grades 0 after a wrong pick', async () => {
    await openWith(MC, 'Grammar');
    expect(content().querySelector('.mc-question')?.textContent).toBe(
      '你__狗吗？',
    );
    const option = (text: string) =>
      Array.from(content().querySelectorAll('.mc-option')).find(
        b => b.textContent === text,
      ) as HTMLElement;
    option('不有').dispatchEvent(new MouseEvent('click'));
    option('有没有').dispatchEvent(new MouseEvent('click'));
    await flush();
    // Any wrong pick fails the card outright — no partial credit.
    expect(appendResult).toHaveBeenCalledWith(
      expect.anything(),
      'history.md',
      MC,
      0,
    );
  });

  it('auto-grades a first-try multiple-choice pick as 5', async () => {
    await openWith(MC, 'Grammar');
    const correct = Array.from(content().querySelectorAll('.mc-option')).find(
      b => b.textContent === '有没有',
    ) as HTMLElement;
    correct.dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(appendResult).toHaveBeenCalledWith(
      expect.anything(),
      'history.md',
      MC,
      5,
    );
  });

  it('renders a cloze card blanked and self-grades after the reveal', async () => {
    await openWith(CLOZE, 'Grammar');
    expect(content().querySelector('.cloze-prompt')?.textContent).toBe(
      '四____月',
    );
    (content().querySelector('.cloze-reveal') as HTMLElement).dispatchEvent(
      new MouseEvent('click'),
    );
    const hard = Array.from(content().querySelectorAll('.cloze-grade')).find(
      b => (b as HTMLElement).dataset.score === '3',
    ) as HTMLElement;
    hard.dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(appendResult).toHaveBeenCalledWith(
      expect.anything(),
      'history.md',
      CLOZE,
      3,
    );
  });

  describe('true/false cards', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const option = (text: string) =>
      Array.from(content().querySelectorAll('.mc-option')).find(
        b => b.textContent === text,
      ) as HTMLElement;

    it('renders via the multi-choice UI; a right pick grades 5 and advances', async () => {
      await openWith(TRUE_FALSE, 'Grammar');
      expect(content().querySelector('.mc-prompt')?.textContent).toBe(
        'Is this correct?',
      );
      expect(content().querySelector('.mc-question')?.textContent).toBe(
        '你有没有一只狗吗？',
      );

      // The statement is wrong, so "Incorrect" is the right pick.
      option('Incorrect').dispatchEvent(new MouseEvent('click'));
      await jest.advanceTimersByTimeAsync(0);
      expect(appendResult).toHaveBeenCalledWith(
        expect.anything(),
        'history.md',
        TRUE_FALSE,
        5,
      );
      // A clean answer shows no correction and advances immediately.
      expect(
        (content().querySelector('.mc-explanation') as HTMLElement).style
          .display,
      ).toBe('none');
      expect(nextDue).toHaveBeenCalledTimes(2); // onOpen + post-grade advance
    });

    it('a wrong pick grades 0, reveals the explanation, and pauses', async () => {
      await openWith(TRUE_FALSE, 'Grammar');
      option('Correct').dispatchEvent(new MouseEvent('click')); // wrong
      // The correction appears the moment the wrong pick happens.
      expect(
        (content().querySelector('.mc-explanation') as HTMLElement).style
          .display,
      ).toBe('block');
      option('Incorrect').dispatchEvent(new MouseEvent('click'));
      await jest.advanceTimersByTimeAsync(0);
      expect(appendResult).toHaveBeenCalledWith(
        expect.anything(),
        'history.md',
        TRUE_FALSE,
        0,
      );
      // The advance waits so the explanation stays readable.
      expect(nextDue).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2500);
      expect(nextDue).toHaveBeenCalledTimes(2);
    });
  });

  describe('wrong-answer explanations on self-graded cards', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('a failed flashcard shows its correction and pauses before advancing', async () => {
      const flash = {...FLASH, explanation: 'Think of the Eiffel Tower.'};
      await openWith(flash, 'Capitals');
      (
        content().querySelector('.flash-card-flip') as HTMLElement
      ).dispatchEvent(new MouseEvent('click'));
      const noIdea = Array.from(
        content().querySelectorAll('.flash-card-grade'),
      ).find(b => (b as HTMLElement).dataset.score === '0');
      (noIdea as HTMLElement).dispatchEvent(new MouseEvent('click'));
      await jest.advanceTimersByTimeAsync(0);

      expect(
        (content().querySelector('.flash-explanation') as HTMLElement).style
          .display,
      ).toBe('block');
      expect(appendResult).toHaveBeenCalledWith(
        expect.anything(),
        'history.md',
        flash,
        0,
      );
      expect(nextDue).toHaveBeenCalledTimes(1); // paused, not advanced yet
      await jest.advanceTimersByTimeAsync(2500);
      expect(nextDue).toHaveBeenCalledTimes(2);
    });

    it('a passed card advances immediately without the correction', async () => {
      const flash = {...FLASH, explanation: 'Think of the Eiffel Tower.'};
      await openWith(flash, 'Capitals');
      (
        content().querySelector('.flash-card-flip') as HTMLElement
      ).dispatchEvent(new MouseEvent('click'));
      const easy = Array.from(
        content().querySelectorAll('.flash-card-grade'),
      ).find(b => (b as HTMLElement).dataset.score === '4');
      (easy as HTMLElement).dispatchEvent(new MouseEvent('click'));
      await jest.advanceTimersByTimeAsync(0);
      expect(nextDue).toHaveBeenCalledTimes(2); // no pause on a pass
    });
  });

  it('shows the empty-bank message for a non-Hanzi bank with no cards', async () => {
    await openWith(null, 'German');
    expect(content().querySelector('.practice-empty')?.textContent).toContain(
      '"German"',
    );
  });

  it('practices several banks as one pool (multi-select state)', async () => {
    nextDue = jest
      .spyOn(HistoryManager, 'getNextDueEntry')
      .mockResolvedValue(FLASH);
    appendResult = jest
      .spyOn(HistoryManager, 'appendResult')
      .mockResolvedValue(undefined);
    makeView();
    await view.setState({banks: ['Capitals', 'German']}, {} as never);
    await view.onOpen();

    expect(view.getDisplayText()).toBe('Practice: Capitals + German');
    // Multi-bank state persists as {banks}; single keeps the legacy {bank}.
    expect(view.getState()).toEqual({banks: ['Capitals', 'German']});
    expect(nextDue).toHaveBeenCalledWith(
      expect.anything(),
      'history.md',
      expect.anything(),
      ['Capitals', 'German'],
    );
    // The bank header names every practiced bank.
    expect(content().querySelector('h2')?.textContent).toBe(
      'Practice: Capitals + German',
    );
  });

  it('shows the multi-bank empty message when the union has no cards', async () => {
    nextDue = jest
      .spyOn(HistoryManager, 'getNextDueEntry')
      .mockResolvedValue(null);
    makeView();
    await view.setState({banks: ['Capitals', 'German']}, {} as never);
    await view.onOpen();
    expect(content().querySelector('.practice-empty')?.textContent).toBe(
      'No cards in the selected banks (Capitals + German) yet.',
    );
  });

  it('renders the hanzi UI from cached fields when stroke data is missing', async () => {
    await openWith(HANZI);
    expect(view.getDisplayText()).toBe('Hanzi Practice');
    expect(content().querySelector('.hanzi-meaning')?.textContent).toBe(
      'Meaning: good',
    );
    // Cached pinyin renders the tone selector (5 options).
    expect(content().querySelectorAll('.tone-selector button')).toHaveLength(5);
    expect(content().querySelector('.hanzi-no-stroke-data')).not.toBeNull();
    expect(content().querySelector('.hanzi-mix-up')).not.toBeNull();
  });

  it('notes the missing pinyin instead of the tone selector', async () => {
    await openWith({...HANZI, pinyin: '', english: ''} as PracticeEntry);
    expect(content().querySelector('.hanzi-meaning')).toBeNull();
    expect(content().textContent).toContain(
      'No pinyin recorded for this character.',
    );
  });

  it('setState after opening switches the bank and re-renders', async () => {
    await openWith(null, 'German');
    nextDue.mockResolvedValue(FLASH);
    await view.setState({bank: 'Capitals'}, {} as never);
    expect(content().querySelector('.flash-card-front')?.textContent).toBe(
      'France',
    );
  });

  it('mix up notices when no alternate character qualifies', async () => {
    await openWith(HANZI);
    jest.spyOn(HistoryManager, 'getMixUpEntry').mockResolvedValue(null);
    await view.handleMixUp();
    expect(noticeMessages).toContain(
      'No other character with valid score range',
    );
  });

  it('mix up re-renders with the alternate entry', async () => {
    await openWith(HANZI);
    jest
      .spyOn(HistoryManager, 'getMixUpEntry')
      .mockResolvedValue({...HANZI, character: '汉', english: 'Han'});
    await view.handleMixUp();
    expect(content().querySelector('.hanzi-meaning')?.textContent).toBe(
      'Meaning: Han',
    );
  });

  describe('handleQuizComplete grading', () => {
    beforeEach(async () => {
      jest.useFakeTimers();
      noticeMessages.length = 0;
      await openWith(HANZI);
    });

    afterEach(() => jest.useRealTimers());

    const complete = async (totalMistakes: number) => {
      await view.handleQuizComplete({character: '好', totalMistakes});
      return (appendResult.mock.calls.at(-1) as unknown[])[3];
    };

    it('grades a clean quiz 5', async () => {
      expect(await complete(0)).toBe(5);
    });

    it('grades a single stroke mistake 4', async () => {
      expect(await complete(1)).toBe(4);
    });

    it('caps the grade by pinyin mistakes', async () => {
      (view as never as {pinyinMistakes: number}).pinyinMistakes = 2;
      expect(await complete(0)).toBe(3);
    });

    it('locks the grade to 0 after Give Up', async () => {
      view.handleGiveUp();
      expect(await complete(0)).toBe(0);
    });

    it('a failed hanzi card surfaces its explanation on the completion page', async () => {
      await openWith({...HANZI, explanation: '女 + 子 — woman with child.'});
      view.handleGiveUp(); // locks the score to 0 → fail
      await complete(0);
      expect(
        content().querySelector('.hanzi-complete-explanation')?.textContent,
      ).toBe('女 + 子 — woman with child.');
    });

    it('a passed hanzi card keeps the explanation off the completion page', async () => {
      await openWith({...HANZI, explanation: '女 + 子 — woman with child.'});
      await complete(0); // clean quiz → 5
      expect(content().querySelector('.hanzi-complete-explanation')).toBeNull();
    });

    it('shows the completion page, then fades into the next card', async () => {
      await complete(1);
      const summary = content().querySelector(
        '.hanzi-complete-summary',
      ) as HTMLElement;
      expect(summary.textContent).toContain('You have completed 好 (good)');
      expect(summary.textContent).toContain('Your score was 4');
      expect(nextDue).toHaveBeenCalledTimes(1); // onOpen only — no advance yet

      await jest.advanceTimersByTimeAsync(2500);
      expect(summary.style.opacity).toBe('0'); // fading away
      await jest.advanceTimersByTimeAsync(400);
      expect(nextDue).toHaveBeenCalledTimes(2); // advanced to the next card
    });
  });

  describe('tone gating', () => {
    beforeEach(async () => {
      jest.useFakeTimers();
      await openWith(HANZI);
      appendResult.mockClear();
    });

    afterEach(() => jest.useRealTimers());

    const finishStrokes = () => {
      (
        view as never as {
          strokeSummary: unknown;
          maybeFinishAttempt: () => void;
        }
      ).strokeSummary = {character: '好', totalMistakes: 0};
      (view as never as {maybeFinishAttempt: () => void}).maybeFinishAttempt();
    };

    it('waits for the tone pick before grading', async () => {
      finishStrokes();
      await jest.advanceTimersByTimeAsync(0);
      expect(appendResult).not.toHaveBeenCalled();
      expect(content().querySelector('.hanzi-complete-summary')).toBeNull();

      // hǎo = prettified hao3 — the correct tone option.
      const correct = Array.from(
        content().querySelectorAll('.tone-selector button'),
      ).find(b => b.textContent === 'hǎo') as HTMLElement;
      correct.dispatchEvent(new MouseEvent('click'));
      await jest.advanceTimersByTimeAsync(0);

      expect(appendResult).toHaveBeenCalledWith(
        expect.anything(),
        'history.md',
        HANZI,
        5,
      );
      expect(content().querySelector('.hanzi-complete-summary')).not.toBeNull();
    });

    it('grades immediately when the tone was answered first', async () => {
      const correct = Array.from(
        content().querySelectorAll('.tone-selector button'),
      ).find(b => b.textContent === 'hǎo') as HTMLElement;
      correct.dispatchEvent(new MouseEvent('click'));
      await jest.advanceTimersByTimeAsync(0);
      expect(appendResult).not.toHaveBeenCalled(); // strokes still pending

      finishStrokes();
      await jest.advanceTimersByTimeAsync(0);
      expect(appendResult).toHaveBeenCalledTimes(1);
    });
  });
});
