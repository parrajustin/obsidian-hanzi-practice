/**
 * Minimal replacement for hanzi-writer, covering exactly what the practice
 * view needs: a stroke-order QUIZ (the user draws each stroke with the
 * pointer, we grade it against the median), a hint highlight when the user
 * keeps missing the same stroke, and an outline/animation fallback for
 * "Give Up". Grading runs on the medians; completed strokes, hints, outlines
 * and the give-up animation render the character's real glyph outlines
 * (shipped in the stroke database) so strokes look like the original font —
 * no network. A stroke missing its outline falls back to a round-capped
 * median polyline.
 */
import {Point} from './geometry';
import {strokeMatches} from './stroke_matcher';
import {CharStrokeData} from '../data/stroke_codec';
import {WrapToResult} from 'standard-ts-lib/src/wrap_to_result';

// All makemeahanzi/hanzi-writer characters share this bounding box (y-up).
const BOUNDS_FROM = {x: 0, y: -124};
const BOUNDS_TO = {x: 1024, y: 900};

// Rendered brush width for median-fallback strokes, in data-space units.
const BRUSH_WIDTH = 50;
// Brush width for the give-up animation's reveal stroke: fat enough that
// sweeping it along the median uncovers the whole clipped glyph outline
// (same value hanzi-writer uses).
const ANIMATION_BRUSH_WIDTH = 200;

const SVG_NS = 'http://www.w3.org/2000/svg';

// Unique-id source for per-stroke animation clip paths (ids are document
// global, and several writers can exist across a session).
let nextClipId = 0;

export interface QuizWriterOptions {
  width: number;
  height: number;
  padding: number;
  /** Highlight the expected stroke after this many misses on it. */
  hintAfterMisses?: number;
}

export interface QuizCallbacks {
  onMistake?: (data: {
    strokeNum: number;
    mistakesOnStroke: number;
    totalMistakes: number;
  }) => void;
  onCorrectStroke?: (data: {
    strokeNum: number;
    strokesRemaining: number;
  }) => void;
  onComplete?: (summary: {character: string; totalMistakes: number}) => void;
}

export class HanziQuizWriter {
  readonly character: string;
  private medians: Point[][];
  private outlines: string[];
  private opts: Required<QuizWriterOptions>;

  private svg: SVGSVGElement;
  private defs: SVGDefsElement;
  private outlineGroup: SVGGElement;
  private completedGroup: SVGGElement;
  private hintGroup: SVGGElement;
  private inkGroup: SVGGElement;

  private scale: number;
  private xOffset: number;
  private yOffset: number;

  private callbacks: QuizCallbacks = {};
  private quizActive = false;
  currentStrokeIndex = 0;
  totalMistakes = 0;
  mistakesOnCurrentStroke = 0;

  private drawing = false;
  private currentInkPoints: Point[] = []; // svg-local px
  private currentInkPath: SVGPathElement | null = null;
  private animationTimers: number[] = [];

  constructor(
    container: HTMLElement,
    character: string,
    strokeData: CharStrokeData,
    options: QuizWriterOptions,
  ) {
    this.character = character;
    this.medians = strokeData.medians.map(stroke =>
      stroke.map(([x, y]) => ({x, y})),
    );
    this.outlines = strokeData.outlines;
    this.opts = {hintAfterMisses: 3, ...options};

    const {width, height, padding} = this.opts;
    const effW = width - 2 * padding;
    const effH = height - 2 * padding;
    const preW = BOUNDS_TO.x - BOUNDS_FROM.x;
    const preH = BOUNDS_TO.y - BOUNDS_FROM.y;
    this.scale = Math.min(effW / preW, effH / preH);
    this.xOffset =
      -BOUNDS_FROM.x * this.scale + padding + (effW - this.scale * preW) / 2;
    this.yOffset =
      -BOUNDS_FROM.y * this.scale + padding + (effH - this.scale * preH) / 2;

    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('width', String(width));
    this.svg.setAttribute('height', String(height));
    this.svg.classList.add('hanzi-quiz-svg');
    // Drawing must never scroll the pane or trigger the mobile back-swipe
    // gesture: disable native touch handling on the surface entirely.
    this.svg.style.touchAction = 'none';
    this.svg.style.userSelect = 'none';
    container.appendChild(this.svg);

    this.defs = document.createElementNS(SVG_NS, 'defs');
    this.svg.appendChild(this.defs);

    // Character-shaped groups live in DATA space (y-up); this transform maps
    // them to screen so glyph outline paths can be used verbatim as `d`.
    const dataTransform = `translate(${this.xOffset}, ${height - this.yOffset}) scale(${this.scale}, ${-this.scale})`;
    this.outlineGroup = this.makeGroup('hanzi-outline-group', dataTransform);
    this.completedGroup = this.makeGroup(
      'hanzi-completed-group',
      dataTransform,
    );
    this.hintGroup = this.makeGroup('hanzi-hint-group', dataTransform);
    // User ink renders in raw svg-local pixels — no transform.
    this.inkGroup = this.makeGroup('hanzi-ink-group');

    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);
    // Belt-and-braces for platforms where touch-action alone doesn't stop
    // history-swipe/scroll gestures (e.g. Obsidian mobile's back gesture):
    // swallow raw touch events before the app's gesture recognizers see them.
    this.svg.addEventListener('touchstart', this.blockNativeTouch, {
      passive: false,
    });
    this.svg.addEventListener('touchmove', this.blockNativeTouch, {
      passive: false,
    });
    this.svg.addEventListener('touchend', this.blockNativeTouch, {
      passive: false,
    });
  }

  get strokeCount(): number {
    return this.medians.length;
  }

  get isComplete(): boolean {
    return this.currentStrokeIndex >= this.medians.length;
  }

  quiz(callbacks: QuizCallbacks) {
    this.callbacks = callbacks;
    this.quizActive = true;
    this.currentStrokeIndex = 0;
    this.totalMistakes = 0;
    this.mistakesOnCurrentStroke = 0;
    this.completedGroup.replaceChildren();
    this.hintGroup.replaceChildren();
    this.inkGroup.replaceChildren();
  }

  /** Draw every stroke's glyph shape in a light outline color (Give Up). */
  showOutline() {
    this.outlineGroup.replaceChildren();
    for (let i = 0; i < this.medians.length; i++) {
      this.outlineGroup.appendChild(
        this.makeStrokeShape(i, '#DDD', 'hanzi-stroke-outline'),
      );
    }
  }

  /** Animate the character stroke by stroke (Give Up). */
  animateCharacter(perStrokeMs = 400) {
    this.clearAnimationTimers();
    this.completedGroup.replaceChildren();
    this.medians.forEach((median, i) => {
      const timer = window.setTimeout(() => {
        // Reveal the real glyph shape by sweeping a fat median stroke inside
        // a clip of the stroke's outline (hanzi-writer's animation technique).
        const strokePath = this.makeMedianPath(
          median,
          '#555',
          'hanzi-stroke-animated',
          this.outlines[i] ? ANIMATION_BRUSH_WIDTH : BRUSH_WIDTH,
        );
        if (this.outlines[i]) {
          const clip = document.createElementNS(SVG_NS, 'clipPath');
          clip.id = `hanzi-anim-clip-${nextClipId++}`;
          const clipShape = document.createElementNS(SVG_NS, 'path');
          clipShape.setAttribute('d', this.outlines[i]);
          clip.appendChild(clipShape);
          this.defs.appendChild(clip);
          strokePath.setAttribute('clip-path', `url(#${clip.id})`);
        }
        const len = strokePath.getTotalLength();
        strokePath.style.strokeDasharray = `${len} ${len}`;
        strokePath.style.strokeDashoffset = String(len);
        strokePath.style.transition = `stroke-dashoffset ${perStrokeMs * 0.9}ms linear`;
        this.completedGroup.appendChild(strokePath);
        // Force a layout so the transition actually runs.
        strokePath.getBoundingClientRect();
        strokePath.style.strokeDashoffset = '0';
      }, i * perStrokeMs);
      this.animationTimers.push(timer);
    });
  }

  /** Display-space (svg-local px) points of a stroke's median. Used by tests. */
  getStrokeDisplayPoints(strokeNum: number): Point[] {
    return this.medians[strokeNum].map(p => this.dataToScreen(p));
  }

  destroy() {
    this.clearAnimationTimers();
    this.svg.remove();
  }

  // --- internals ----------------------------------------------------------

  private makeGroup(cls: string, transform?: string): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add(cls);
    if (transform) g.setAttribute('transform', transform);
    this.svg.appendChild(g);
    return g;
  }

  private dataToScreen(p: Point): Point {
    return {
      x: p.x * this.scale + this.xOffset,
      y: this.opts.height - this.yOffset - p.y * this.scale,
    };
  }

  private screenToData(p: Point): Point {
    return {
      x: (p.x - this.xOffset) / this.scale,
      y: (this.opts.height - this.yOffset - p.y) / this.scale,
    };
  }

  private pathString(points: Point[]): string {
    return points
      .map(
        (p, i) =>
          `${i === 0 ? 'M' : 'L'} ${Math.round(p.x * 10) / 10} ${Math.round(p.y * 10) / 10}`,
      )
      .join(' ');
  }

  /**
   * The stroke's rendered shape, in data space: the real glyph outline
   * (filled) when the database has one, else the round-capped median
   * polyline fallback.
   */
  private makeStrokeShape(
    strokeNum: number,
    color: string,
    cls: string,
  ): SVGPathElement {
    const outline = this.outlines[strokeNum];
    if (outline) {
      const pathEl = document.createElementNS(SVG_NS, 'path');
      pathEl.setAttribute('d', outline);
      pathEl.setAttribute('fill', color);
      pathEl.classList.add(cls);
      return pathEl;
    }
    return this.makeMedianPath(this.medians[strokeNum], color, cls);
  }

  /** Round-capped polyline along a median, in data space. */
  private makeMedianPath(
    median: Point[],
    color: string,
    cls: string,
    brushWidth = BRUSH_WIDTH,
  ): SVGPathElement {
    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.setAttribute('d', this.pathString(median));
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke', color);
    pathEl.setAttribute('stroke-width', String(brushWidth));
    pathEl.setAttribute('stroke-linecap', 'round');
    pathEl.setAttribute('stroke-linejoin', 'round');
    pathEl.classList.add(cls);
    return pathEl;
  }

  private svgLocalPoint(evt: PointerEvent): Point {
    const rect = this.svg.getBoundingClientRect();
    return {x: evt.clientX - rect.left, y: evt.clientY - rect.top};
  }

  private blockNativeTouch = (evt: TouchEvent) => {
    evt.preventDefault();
  };

  private onPointerDown = (evt: PointerEvent) => {
    if (!this.quizActive || this.isComplete) return;
    evt.preventDefault();
    // Synthetic events (tests) may carry a pointerId with no active pointer;
    // a failed capture is harmless, so the Result is deliberately dropped.
    WrapToResult(
      () => this.svg.setPointerCapture(evt.pointerId),
      'setPointerCapture failed',
    );
    this.drawing = true;
    this.currentInkPoints = [this.svgLocalPoint(evt)];
    this.currentInkPath = document.createElementNS(SVG_NS, 'path');
    this.currentInkPath.setAttribute('fill', 'none');
    this.currentInkPath.setAttribute('stroke', '#333');
    this.currentInkPath.setAttribute('stroke-width', '4');
    this.currentInkPath.setAttribute('stroke-linecap', 'round');
    this.currentInkPath.setAttribute('stroke-linejoin', 'round');
    this.currentInkPath.classList.add('hanzi-user-stroke');
    this.inkGroup.appendChild(this.currentInkPath);
    this.updateInkPath();
  };

  private onPointerMove = (evt: PointerEvent) => {
    if (!this.drawing) return;
    evt.preventDefault();
    this.currentInkPoints.push(this.svgLocalPoint(evt));
    this.updateInkPath();
  };

  private onPointerUp = (evt: PointerEvent) => {
    if (!this.drawing) return;
    evt.preventDefault();
    this.drawing = false;
    this.currentInkPoints.push(this.svgLocalPoint(evt));
    this.gradeCurrentInk();
  };

  private updateInkPath() {
    if (this.currentInkPath) {
      this.currentInkPath.setAttribute(
        'd',
        this.pathString(this.currentInkPoints),
      );
    }
  }

  private gradeCurrentInk() {
    const inkPoints = this.currentInkPoints;
    this.currentInkPath?.remove();
    this.currentInkPath = null;
    this.currentInkPoints = [];
    if (this.isComplete) return;

    const dataPoints = inkPoints.map(p => this.screenToData(p));
    const strokeNum = this.currentStrokeIndex;
    const matched = strokeMatches(
      dataPoints,
      this.medians[strokeNum],
      strokeNum,
    );

    if (matched) {
      this.hintGroup.replaceChildren();
      this.mistakesOnCurrentStroke = 0;
      this.completedGroup.appendChild(
        this.makeStrokeShape(strokeNum, '#555', 'hanzi-stroke-done'),
      );
      this.currentStrokeIndex++;
      this.callbacks.onCorrectStroke?.({
        strokeNum,
        strokesRemaining: this.medians.length - this.currentStrokeIndex,
      });
      if (this.isComplete) {
        this.quizActive = false;
        this.callbacks.onComplete?.({
          character: this.character,
          totalMistakes: this.totalMistakes,
        });
      }
    } else {
      this.totalMistakes++;
      this.mistakesOnCurrentStroke++;
      this.callbacks.onMistake?.({
        strokeNum,
        mistakesOnStroke: this.mistakesOnCurrentStroke,
        totalMistakes: this.totalMistakes,
      });
      // The user keeps missing this stroke: highlight the expected stroke as
      // a hint. It stays visible until the stroke is drawn correctly.
      if (
        this.mistakesOnCurrentStroke >= this.opts.hintAfterMisses &&
        this.hintGroup.childElementCount === 0
      ) {
        this.hintGroup.appendChild(
          this.makeStrokeShape(strokeNum, '#FF9800', 'hanzi-stroke-hint'),
        );
      }
    }
  }

  private clearAnimationTimers() {
    for (const t of this.animationTimers) window.clearTimeout(t);
    this.animationTimers = [];
  }
}
