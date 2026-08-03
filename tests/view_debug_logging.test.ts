/**
 * The debug trail the practice view is expected to produce. These assertions
 * are the contract a bug report relies on: which banks were resolved, which
 * card was chosen, which renderer drew it, and how a grade was computed.
 */

import {App, WorkspaceLeaf} from 'obsidian';
import {Err} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {HanziPracticeView} from '../src/views/hanzi_view';
import {HistoryManager} from '../src/utils/history_manager';
import {CardType, PracticeEntry} from '../src/utils/practice_list';
import {InitTelemetry, ResetTelemetry} from '../src/telemetry/telemetry';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Open the leaf the way Obsidian does. The view defers its first load until
 * the leaf's state lands (see HanziPracticeView.onOpen), so a test that opens
 * without setting state first must let that tick run.
 */
const openView = async (view: HanziPracticeView) => {
  await view.onOpen();
  await flush();
};

interface LoggedRecord {
  level: string;
  message: string;
  data: Record<string, unknown>;
}

const FLASH: PracticeEntry = {
  id: 'aaaaaaaa',
  cardType: CardType.FLASHCARD,
  bank: 'Capitals',
  front: 'France',
  back: 'Paris',
};

const MC: PracticeEntry = {
  id: 'bbbbbbbb',
  cardType: CardType.MULTIPLE_CHOICE,
  bank: 'Grammar',
  question: '你__狗吗？',
  answer: '有没有',
  distractors: ['不有'],
};

describe('practice view debug logging', () => {
  let logs: LoggedRecord[];
  let groups: Array<{action: string; name?: string; id?: string}>;
  let view: HanziPracticeView;

  const find = (message: string) => logs.filter(l => l.message === message);

  beforeEach(() => {
    ResetTelemetry();
    logs = [];
    groups = [];
    let nextGroupId = 0;
    window.bugCollector = {
      apiVersion: 3,
      register: () => ({
        pluginId: 'hanzi-practice',
        pluginVersion: '1.0.0',
        getBaggage: () => ({}),
        setBaggage: () => {},
        log: (level: string, message: string, data: Record<string, unknown>) =>
          void logs.push({level, message, data}),
        getTracer: () => ({}),
        getMeter: () => ({
          createCounter: () => ({add: () => {}}),
          createHistogram: () => ({record: () => {}}),
          createObservableGauge: () => ({addCallback: () => {}}),
        }),
        start: () => {},
        restart: () => {},
        end: () => {},
        startGroup: (name: string) => {
          const id = `group-${nextGroupId++}`;
          groups.push({action: 'start', name, id});
          return id;
        },
        endGroup: (id?: string) => void groups.push({action: 'end', id}),
      }),
    } as never;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    InitTelemetry('3.5.0');

    const plugin = {
      app: new App(),
      settings: {
        version: 2,
        historyFilePath: 'history.md',
        practiceFilePath: 'words.md',
        banks: [{name: 'Capitals', filePath: 'capitals.md'}],
        dataPacks: [],
      },
      getStrokeData: jest
        .fn()
        .mockResolvedValue(Err(NotFoundError('no stroke db in tests'))),
      refreshReviewCounts: jest.fn().mockResolvedValue(undefined),
    } as never;
    view = new HanziPracticeView(new WorkspaceLeaf() as never, plugin);
  });

  afterEach(() => {
    ResetTelemetry();
    delete window.bugCollector;
    jest.restoreAllMocks();
  });

  it('opens a session group for the leaf and closes it on unload', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(null);
    await openView(view);
    expect(groups[0]).toMatchObject({action: 'start', name: 'practice:Hanzi'});

    await view.onClose();
    expect(groups[1]).toEqual({action: 'end', id: groups[0]!.id});
  });

  it('scopes the session group to the banks the leaf actually practices', async () => {
    // The group must be named (and the session opened) only once the leaf's
    // real banks have landed — Obsidian delivers them after onOpen, so naming
    // it there would file every multi-bank session under "practice:Hanzi".
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(null);
    await view.onOpen();
    await view.setState({banks: ['Capitals', 'German']}, {
      history: false,
    } as never);
    await flush();

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      action: 'start',
      name: 'practice:Capitals+German',
    });
    expect(find('Practice view opened (leaf)')).toHaveLength(1);
    expect(find('Resolved practice bank sources')).toHaveLength(1);
  });

  it('logs the leaf opening with its banks', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(null);
    await openView(view);
    const opened = find('Practice view opened (leaf)')[0]!;
    expect(opened.level).toBe('info');
    expect(opened.data['banks']).toEqual(['Hanzi']);
  });

  it('logs which bank sources were resolved', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(null);
    await openView(view);
    const resolved = find('Resolved practice bank sources')[0]!;
    expect(resolved.data['requestedBanks']).toEqual(['Hanzi']);
    expect(resolved.data['availableSources']).toEqual([
      {name: 'Hanzi', filePath: 'words.md'},
      {name: 'Capitals', filePath: 'capitals.md'},
    ]);
    expect(resolved.data['brokenDataPacks']).toEqual([]);
  });

  it('logs the selected card with its id, type and bank', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
    await openView(view);
    const selected = find('Next due card selected')[0]!;
    expect(selected.data).toMatchObject({
      id: 'aaaaaaaa',
      cardType: CardType.FLASHCARD,
      cardTypeName: 'FLASHCARD',
      bank: 'Capitals',
    });
  });

  it('logs which RENDERER drew the card', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
    await openView(view);
    const shown = find('Card shown')[0]!;
    expect(shown.data['renderer']).toBe('flashcard');
    expect(shown.data['id']).toBe('aaaaaaaa');
  });

  it('logs the prompt side chosen for a flashcard', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
    await openView(view);
    const side = find('Flashcard prompt side chosen')[0]!;
    expect(side.data['promptSide']).toBe('front');
    expect(side.data['promptText']).toBe('France');
  });

  it('logs the grade with the card identity and duration', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
    jest.spyOn(HistoryManager, 'appendResult').mockResolvedValue(undefined);
    await openView(view);
    await view.handleCardGrade(FLASH, 4);
    await flush();

    const graded = find('Card graded')[0]!;
    expect(graded.data).toMatchObject({
      id: 'aaaaaaaa',
      cardTypeName: 'FLASHCARD',
      bank: 'Capitals',
      score: 4,
      passed: true,
    });
    expect(typeof graded.data['durationMs']).toBe('number');
  });

  it('logs an empty bank instead of silently rendering nothing', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(null);
    await view.setState({bank: 'Capitals'}, {history: false} as never);
    await openView(view);
    expect(
      find('Rendered empty-bank message (no cards to practice)'),
    ).toHaveLength(1);
  });

  describe('the user-input track', () => {
    const click = (selector: string) => {
      const el = view.containerEl.querySelector(selector);
      expect(el).not.toBeNull();
      (el as HTMLElement).dispatchEvent(
        new MouseEvent('click', {bubbles: true}),
      );
    };

    it('logs every control pressed, with the card it was pressed on', async () => {
      jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
      await openView(view);

      click('.flash-card-flip');
      const clicks = find('User clicked');
      expect(clicks).toHaveLength(1);
      expect(clicks[0]!.data).toMatchObject({
        surface: 'practice-view',
        control: 'button',
        label: 'Show Answer',
        classes: ['flash-card-flip'],
        // The card on screen when it was pressed.
        id: 'aaaaaaaa',
        bank: 'Capitals',
      });
    });

    it('carries a grade button score in the click log', async () => {
      jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
      jest.spyOn(HistoryManager, 'appendResult').mockResolvedValue(undefined);
      await openView(view);

      click('.flash-card-flip');
      click('.flash-card-grade[data-score="4"]');
      const graded = find('User clicked').at(-1)!;
      expect(graded.data).toMatchObject({
        label: 'Easy',
        classes: ['flash-card-grade'],
        data: {score: '4'},
      });
    });

    it('ignores clicks that are not on a control', async () => {
      jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
      await openView(view);

      click('.flash-card-front'); // the prompt text, not a button
      expect(find('User clicked')).toHaveLength(0);
    });

    it('logs revealing the answer as its own action', async () => {
      jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
      await openView(view);

      click('.flash-card-flip');
      const revealed = find('User action: revealed the answer')[0]!;
      expect(revealed.data).toMatchObject({
        renderer: 'flashcard',
        id: 'aaaaaaaa',
      });
      expect(typeof revealed.data['secondsThinking']).toBe('number');
    });

    it('logs each answer picked on an auto-graded card, right or wrong', async () => {
      jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(MC);
      jest.spyOn(HistoryManager, 'appendResult').mockResolvedValue(undefined);
      await openView(view);

      const options = Array.from(
        view.containerEl.querySelectorAll<HTMLElement>('.mc-option'),
      );
      const wrong = options.find(o => o.textContent === '不有')!;
      const right = options.find(o => o.textContent === '有没有')!;
      wrong.dispatchEvent(new MouseEvent('click', {bubbles: true}));
      right.dispatchEvent(new MouseEvent('click', {bubbles: true}));

      const picks = find('User action: picked an answer');
      expect(picks).toHaveLength(2);
      expect(picks[0]!.data).toMatchObject({
        renderer: 'multi-choice',
        option: '不有',
        correct: false,
        mistakesSoFar: 1,
        id: 'bbbbbbbb',
      });
      expect(picks[1]!.data).toMatchObject({
        option: '有没有',
        correct: true,
        mistakesSoFar: 1,
      });
    });

    it('logs leaving the plugin with what the session amounted to', async () => {
      jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(FLASH);
      jest.spyOn(HistoryManager, 'appendResult').mockResolvedValue(undefined);
      await openView(view);
      await view.handleCardGrade(FLASH, 4);
      await flush();

      await view.onClose();
      const left = find(
        'User action: left the practice view (leaf closed)',
      )[0]!;
      expect(left.data).toMatchObject({
        banks: ['Hanzi'],
        cardsGraded: 1,
      });
      expect(left.data['cardsShown']).toBeGreaterThanOrEqual(1);
      expect(typeof left.data['sessionSeconds']).toBe('number');
    });
  });

  it('logs a bank switch through view state', async () => {
    jest.spyOn(HistoryManager, 'getNextDueEntry').mockResolvedValue(null);
    await view.setState({banks: ['Capitals', 'German']}, {
      history: false,
    } as never);
    const switched = find('View state changed: practice banks switched')[0]!;
    expect(switched.data['from']).toEqual(['Hanzi']);
    expect(switched.data['to']).toEqual(['Capitals', 'German']);
  });
});
