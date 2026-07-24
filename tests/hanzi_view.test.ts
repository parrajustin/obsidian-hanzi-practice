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
        version: 1,
        historyFilePath: 'history.md',
        practiceFilePath: 'words.md',
        banks: [],
      },
      // No stroke database in unit tests — the view must degrade to the
      // .hanzi-no-stroke-data message instead of constructing a quiz writer.
      getStrokeData: jest
        .fn()
        .mockResolvedValue(Err(NotFoundError('no stroke db in tests'))),
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

  it('renders a multiple-choice card and auto-grades 2 after one wrong pick', async () => {
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
    expect(appendResult).toHaveBeenCalledWith(
      expect.anything(),
      'history.md',
      MC,
      2,
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

  it('shows the empty-bank message for a non-Hanzi bank with no cards', async () => {
    await openWith(null, 'German');
    expect(content().querySelector('.practice-empty')?.textContent).toContain(
      '"German"',
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
      noticeMessages.length = 0;
      await openWith(HANZI);
    });

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
  });
});
