/**
 * In-page harness for the COMPONENT golden test (see component_runner.ts).
 *
 * Bundled to tests/component_harness.js and injected into a throwaway
 * Obsidian window whose body has been cleared. Two mount modes:
 *
 *  - mount():     ONLY the HanziQuizWriter on a fixed white stage.
 *  - mountView(): the full HanziPracticeView (heading, meaning line, tone
 *    selector, quiz writer, Give Up / Mix Up controls) with a stubbed plugin.
 *    The 'obsidian' module is aliased to tests/obsidian_browser_stub.ts at
 *    bundle time; Obsidian's global DOM helpers (createEl/…) come from the
 *    real window hosting the harness.
 *
 * Both decode the real shipped stroke database (passed in as base64) and
 * expose deterministic drivers on `window.componentHarness` — synthetic
 * pointer events at fixed coordinates, so every rendered state is
 * pixel-reproducible.
 */
import {HanziQuizWriter} from '../src/writer/quiz_writer';
import {StrokeDataReader} from '../src/data/stroke_codec';
import {HanziPracticeView} from '../src/views/hanzi_view';
import {CardType, HANZI_BANK} from '../src/utils/practice_list';
import {HistoryManager} from '../src/utils/history_manager';
import {prettifyPinyin} from '../src/utils/prettify_pinyin';
import {Ok} from 'standard-ts-lib/src/result';

interface HarnessEvent {
  type:
    'mistake' | 'correct' | 'complete' | 'practiceComplete' | 'historyAppend';
  detail: unknown;
}

let writer: HanziQuizWriter | null = null;
let view: HanziPracticeView | null = null;
let events: HarnessEvent[] = [];
let stage: HTMLDivElement | null = null;
let bubbleCount = 0;

/** After the view advances to a new card it builds a NEW writer. */
function activeWriter(): HanziQuizWriter {
  const w = view ? ((view as any).writer ?? writer) : writer;
  if (!w) throw new Error('harness: no writer mounted');
  return w as HanziQuizWriter;
}

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function svgEl(): SVGSVGElement {
  const el = stage?.querySelector('svg');
  if (!el) throw new Error('harness: no svg mounted');
  return el as SVGSVGElement;
}

/** A fixed stage: white background, no Obsidian chrome, stable position. */
function makeStage(width: number, height: number): HTMLDivElement {
  document.body.innerHTML = '';
  view = null;
  writer = null;
  stage = document.createElement('div');
  stage.id = 'component-stage';
  Object.assign(stage.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
    padding: '10px',
    background: '#ffffff',
    // The Obsidian window may run a dark theme; pin readable text so the
    // view's headings/labels render identically on any host.
    color: '#333333',
    zIndex: '99999',
    boxSizing: 'content-box',
    overflow: 'hidden',
  });
  document.body.appendChild(stage);
  return stage;
}

function makeReader(strokeDataB64: string): StrokeDataReader {
  return StrokeDataReader.create(decodeBase64(strokeDataB64)).unsafeUnwrap();
}

const harness = {
  /**
   * Clear the page and mount a fresh writer for `char`, reading its stroke
   * data (medians + glyph outlines) from the (gunzipped, base64-encoded) HZS2
   * stroke database — the same blob the plugin ships. Returns basic facts for
   * assertions.
   */
  mount(strokeDataB64: string, char: string) {
    const stageEl = makeStage(320, 320);
    const box = document.createElement('div');
    box.style.width = '300px';
    box.style.height = '300px';
    box.style.border = '1px solid #ccc';
    stageEl.appendChild(box);

    const reader = makeReader(strokeDataB64);
    const strokeData = reader.get(char);
    if (!strokeData) throw new Error(`harness: no stroke data for ${char}`);
    writer = new HanziQuizWriter(box, char, strokeData, {
      width: 300,
      height: 300,
      padding: 5,
    });
    events = [];
    writer.quiz({
      onMistake: d => events.push({type: 'mistake', detail: d}),
      onCorrectStroke: d => events.push({type: 'correct', detail: d}),
      onComplete: s => events.push({type: 'complete', detail: s}),
      onPracticeComplete: () =>
        events.push({type: 'practiceComplete', detail: null}),
    });
    (window as any).writer = writer;
    return {strokeCount: writer.strokeCount, dbChars: reader.size};
  },

  /**
   * Mount the full HanziPracticeView practicing one hanzi entry, with a
   * stubbed plugin (real stroke DB, no vault). HistoryManager's statics are
   * patched: appendResult captures a 'historyAppend' event and
   * getNextDueEntry serves a fixed follow-up card (汉), so the real grading
   * + completion-page + advance flow runs without any vault content.
   */
  async mountView(strokeDataB64: string, char: string) {
    const stageEl = makeStage(360, 600);
    const reader = makeReader(strokeDataB64);
    const plugin = {
      app: (window as any).app,
      settings: {
        version: 1,
        historyFilePath: 'history.md',
        practiceFilePath: 'words.md',
        banks: [],
      },
      getStrokeData: () => Promise.resolve(Ok(reader)),
    };
    (HistoryManager as any).appendResult = (
      _app: unknown,
      _path: unknown,
      entry: {id: string},
      score: number,
    ) => {
      events.push({type: 'historyAppend', detail: {id: entry.id, score}});
      return Promise.resolve();
    };
    (HistoryManager as any).getNextDueEntry = () =>
      Promise.resolve({
        id: 'eeeeeeee',
        cardType: CardType.HANZI,
        bank: HANZI_BANK,
        character: '汉',
        pinyin: 'han4',
        english: 'Chinese',
      });
    view = new HanziPracticeView({} as any, plugin as any);
    events = [];
    stageEl.appendChild(view.containerEl);
    const entry = {
      id: 'dddddddd',
      cardType: CardType.HANZI,
      bank: HANZI_BANK,
      character: char,
      pinyin: 'hao3',
      english: 'good',
    };
    await (view as any).renderPractice(entry);
    writer = (view as any).writer;
    if (!writer) throw new Error(`harness: view built no writer for ${char}`);
    (window as any).writer = writer;
    // The view wired its own callbacks in startQuiz; wrap them so the runner
    // can also observe the raw writer events.
    const cbs = (writer as any).callbacks;
    (writer as any).callbacks = {
      onMistake: (d: unknown) => {
        events.push({type: 'mistake', detail: d});
        cbs.onMistake?.(d);
      },
      onCorrectStroke: (d: unknown) => {
        events.push({type: 'correct', detail: d});
        cbs.onCorrectStroke?.(d);
      },
      onComplete: (s: unknown) => {
        events.push({type: 'complete', detail: s});
        cbs.onComplete?.(s);
      },
      onPracticeComplete: () => {
        events.push({type: 'practiceComplete', detail: null});
        cbs.onPracticeComplete?.();
      },
    };
    return {
      strokeCount: writer.strokeCount,
      heading: stageEl.querySelector('h2')?.textContent ?? null,
      meaning: stageEl.querySelector('.hanzi-meaning')?.textContent ?? null,
      toneButtons: stageEl.querySelectorAll('.tone-selector button').length,
      buttons: Array.from(stageEl.querySelectorAll('button'))
        .map(b => b.textContent)
        .filter(t => t === 'Give Up' || t === 'Mix Up'),
    };
  },

  /**
   * The tone selector shuffles its options; DOM-sort them by label so
   * view screenshots are pixel-deterministic (same trick as the E2E's
   * multiple-choice steps).
   */
  sortToneButtons() {
    const box = stage?.querySelector('.tone-selector');
    if (!box) throw new Error('harness: no tone selector mounted');
    const buttons = Array.from(box.querySelectorAll('button'));
    buttons.sort((a, b) =>
      (a.textContent ?? '').localeCompare(b.textContent ?? ''),
    );
    for (const b of buttons) box.appendChild(b);
  },

  /** Click the practice view's Give Up button. */
  clickGiveUp() {
    const button = Array.from(stage?.querySelectorAll('button') ?? []).find(
      b => b.textContent === 'Give Up',
    );
    if (!button) throw new Error('harness: no Give Up button mounted');
    button.click();
  },

  /** Dispatch a synthetic pointer stroke along svg-local points. */
  draw(points: Array<{x: number; y: number}>, opts: {holdLast?: boolean} = {}) {
    const svg = svgEl();
    const rect = svg.getBoundingClientRect();
    const ev = (type: string, p: {x: number; y: number}) =>
      svg.dispatchEvent(
        new PointerEvent(type, {
          clientX: rect.left + p.x,
          clientY: rect.top + p.y,
          pointerId: 1,
          bubbles: true,
        }),
      );
    ev('pointerdown', points[0]);
    for (const p of points.slice(1)) ev('pointermove', p);
    // holdLast leaves the pointer down so the in-progress ink stays rendered.
    if (!opts.holdLast) ev('pointerup', points[points.length - 1]);
  },

  /** Finish a stroke started with holdLast. */
  release(p: {x: number; y: number}) {
    const svg = svgEl();
    const rect = svg.getBoundingClientRect();
    svg.dispatchEvent(
      new PointerEvent('pointerup', {
        clientX: rect.left + p.x,
        clientY: rect.top + p.y,
        pointerId: 1,
        bubbles: true,
      }),
    );
  },

  /** A deliberately-wrong stroke: short scribble in the top-right corner. */
  drawWrong() {
    harness.draw([
      {x: 265, y: 30},
      {x: 275, y: 39},
      {x: 285, y: 48},
    ]);
  },

  /** Replay stroke `i`'s median in screen space — always grades correct. */
  drawCorrect(i: number) {
    harness.draw(activeWriter().getStrokeDisplayPoints(i));
  },

  /**
   * Count pointer/touch events that bubble past the drawing surface to the
   * document body — the writer must stop them all (Obsidian mobile turns a
   * bubbled swipe into the pull-down command menu).
   */
  installBubbleProbe() {
    bubbleCount = 0;
    for (const type of [
      'pointerdown',
      'pointermove',
      'pointerup',
      'touchstart',
      'touchmove',
      'touchend',
    ]) {
      document.body.addEventListener(type, evt => {
        if ((evt.target as Element | null)?.closest?.('svg')) bubbleCount++;
      });
    }
  },

  /**
   * Dispatch a native-style touch on the svg; returns true when the writer
   * both canceled it (preventDefault) and it never bubbled to the body.
   */
  probeTouch() {
    const svg = svgEl();
    const before = bubbleCount;
    const notCanceled = svg.dispatchEvent(
      new TouchEvent('touchmove', {bubbles: true, cancelable: true}),
    );
    return !notCanceled && bubbleCount === before;
  },

  /**
   * Disable stroke-animation transitions and the flash animations so
   * animation/flash frames are discrete and pixel-stable.
   */
  disableTransitions() {
    const style = document.createElement('style');
    style.textContent =
      '.hanzi-stroke-animated { transition: none !important; }\n' +
      '.hanzi-stroke-current, .hanzi-user-stroke-wrong {' +
      ' animation: none !important; }';
    document.head.appendChild(style);
  },

  showOutline: () => writer!.showOutline(),
  startPractice: () => writer!.startGuidedPractice(),
  animate: (perStrokeMs?: number) => writer!.animateCharacter(perStrokeMs),

  // Test knobs for the flash/replay/pause timers, so goldens can freeze a
  // frame (huge value) and the runner can move on without waiting.
  setWrongFlashMs(ms: number) {
    activeWriter().wrongFlashMs = ms;
  },
  setReplayMs(ms: number) {
    activeWriter().replayPerStrokeMs = ms;
  },
  setReplayPause(ms: number) {
    activeWriter().replayPauseMs = ms;
  },
  clearWrongInk() {
    (activeWriter() as any).clearWrongInk();
  },
  /** Skip the post-practice pause: start the replay animation now. */
  beginReplay() {
    const w = activeWriter() as any;
    w.clearAnimationTimers();
    w.startReplay();
  },
  /** Skip the guided-practice replay: jump straight to the self-test. */
  finishReplay() {
    (activeWriter() as any).resetForSelfTest();
  },

  /** Click the tone button carrying the current entry's correct pinyin. */
  clickCorrectTone() {
    const label = prettifyPinyin((view as any).targetPinyin);
    const button = Array.from(
      stage?.querySelectorAll('.tone-selector button') ?? [],
    ).find(b => b.textContent === label) as HTMLButtonElement | undefined;
    if (!button) throw new Error(`harness: no tone button "${label}"`);
    button.click();
  },

  state() {
    const w = activeWriter();
    return {
      strokeIndex: w.currentStrokeIndex,
      totalMistakes: w.totalMistakes,
      mistakesOnCurrentStroke: w.mistakesOnCurrentStroke,
      isComplete: w.isComplete,
      isGuided: w.isGuided,
      hintShown: !!document.querySelector('.hanzi-stroke-hint'),
      doneStrokes: document.querySelectorAll('.hanzi-stroke-done').length,
      animatedStrokes: document.querySelectorAll('.hanzi-stroke-animated')
        .length,
      outlineStrokes: document.querySelectorAll('.hanzi-stroke-outline').length,
      currentFlash: document.querySelectorAll('.hanzi-stroke-current').length,
      wrongInk: document.querySelectorAll('.hanzi-user-stroke-wrong').length,
      inkVisible: !!document.querySelector('.hanzi-user-stroke'),
      svgComplete: !!document.querySelector('svg.hanzi-quiz-complete'),
      completionText:
        document.querySelector('.hanzi-complete-summary')?.textContent ?? null,
      bubbleCount,
      view: view
        ? {
            strokeMistakes: (view as any).strokeMistakes,
            gaveUp: (view as any).gaveUp,
            currentCharacter: (view as any).currentCharacter,
            meaning:
              stage?.querySelector('.hanzi-meaning')?.textContent ?? null,
          }
        : null,
      events,
    };
  },

  /** Stage rect (viewport CSS px) for clipping screenshots. */
  rect() {
    const r = stage!.getBoundingClientRect();
    return {x: r.left, y: r.top, width: r.width, height: r.height};
  },
};

(window as any).componentHarness = harness;
