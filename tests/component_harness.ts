/**
 * In-page harness for the COMPONENT golden test (see component_runner.ts).
 *
 * Bundled to tests/component_harness.js and injected into a throwaway
 * Obsidian window whose body has been cleared: it mounts ONLY the
 * HanziQuizWriter on a fixed white stage, decodes the real shipped stroke
 * database (passed in as base64), and exposes deterministic drivers on
 * `window.componentHarness` — synthetic pointer events at fixed coordinates,
 * so every rendered state is pixel-reproducible.
 */
import {HanziQuizWriter} from '../src/writer/quiz_writer';
import {StrokeDataReader} from '../src/data/stroke_codec';

interface HarnessEvent {
  type: 'mistake' | 'correct' | 'complete';
  detail: unknown;
}

let writer: HanziQuizWriter | null = null;
let events: HarnessEvent[] = [];
let stage: HTMLDivElement | null = null;

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

const harness = {
  /**
   * Clear the page and mount a fresh writer for `char`, reading its medians
   * from the (gunzipped, base64-encoded) HZS1 stroke database — the same blob
   * the plugin ships. Returns basic facts for assertions.
   */
  mount(strokeDataB64: string, char: string) {
    document.body.innerHTML = '';
    // A fixed stage: white background, no Obsidian chrome, stable position.
    stage = document.createElement('div');
    stage.id = 'component-stage';
    Object.assign(stage.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '320px',
      height: '320px',
      padding: '10px',
      background: '#ffffff',
      zIndex: '99999',
      boxSizing: 'content-box',
    });
    document.body.appendChild(stage);
    const box = document.createElement('div');
    box.style.width = '300px';
    box.style.height = '300px';
    box.style.border = '1px solid #ccc';
    stage.appendChild(box);

    const reader = StrokeDataReader.create(
      decodeBase64(strokeDataB64),
    ).unsafeUnwrap();
    const medians = reader.get(char);
    if (!medians) throw new Error(`harness: no stroke data for ${char}`);
    writer = new HanziQuizWriter(box, char, medians, {
      width: 300,
      height: 300,
      padding: 5,
    });
    events = [];
    writer.quiz({
      onMistake: d => events.push({type: 'mistake', detail: d}),
      onCorrectStroke: d => events.push({type: 'correct', detail: d}),
      onComplete: s => events.push({type: 'complete', detail: s}),
    });
    (window as any).writer = writer;
    return {strokeCount: writer.strokeCount, dbChars: reader.size};
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
    harness.draw(writer!.getStrokeDisplayPoints(i));
  },

  /** Disable stroke-animation transitions so animation frames are discrete. */
  disableTransitions() {
    const style = document.createElement('style');
    style.textContent =
      '.hanzi-stroke-animated { transition: none !important; }';
    document.head.appendChild(style);
  },

  showOutline: () => writer!.showOutline(),
  animate: (perStrokeMs?: number) => writer!.animateCharacter(perStrokeMs),

  state() {
    return {
      strokeIndex: writer!.currentStrokeIndex,
      totalMistakes: writer!.totalMistakes,
      mistakesOnCurrentStroke: writer!.mistakesOnCurrentStroke,
      isComplete: writer!.isComplete,
      hintShown: !!document.querySelector('.hanzi-stroke-hint'),
      doneStrokes: document.querySelectorAll('.hanzi-stroke-done').length,
      animatedStrokes: document.querySelectorAll('.hanzi-stroke-animated')
        .length,
      outlineStrokes: document.querySelectorAll('.hanzi-stroke-outline').length,
      inkVisible: !!document.querySelector('.hanzi-user-stroke'),
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
