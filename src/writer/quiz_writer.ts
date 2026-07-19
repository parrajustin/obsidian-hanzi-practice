/**
 * Minimal replacement for hanzi-writer, covering exactly what the practice
 * view needs: a stroke-order QUIZ (the user draws each stroke with the
 * pointer, we grade it against the median), a hint highlight when the user
 * keeps missing the same stroke, and an outline/animation fallback for
 * "Give Up". Everything renders from the medians-only stroke database — no
 * glyph outlines, no network.
 */
import {Point} from './geometry';
import {strokeMatches} from './stroke_matcher';
import {CharMedians} from '../data/stroke_codec';

// All makemeahanzi/hanzi-writer characters share this bounding box (y-up).
const BOUNDS_FROM = {x: 0, y: -124};
const BOUNDS_TO = {x: 1024, y: 900};

// Rendered brush width, in data-space units (scaled to pixels at draw time).
const BRUSH_WIDTH = 50;

const SVG_NS = 'http://www.w3.org/2000/svg';

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
  private opts: Required<QuizWriterOptions>;

  private svg: SVGSVGElement;
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
    medians: CharMedians,
    options: QuizWriterOptions,
  ) {
    this.character = character;
    this.medians = medians.map(stroke => stroke.map(([x, y]) => ({x, y})));
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
    this.svg.style.touchAction = 'none';
    container.appendChild(this.svg);

    this.outlineGroup = this.makeGroup('hanzi-outline-group');
    this.completedGroup = this.makeGroup('hanzi-completed-group');
    this.hintGroup = this.makeGroup('hanzi-hint-group');
    this.inkGroup = this.makeGroup('hanzi-ink-group');

    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);
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

  /** Draw every stroke's median in a light outline color (Give Up). */
  showOutline() {
    this.outlineGroup.replaceChildren();
    for (const median of this.medians) {
      this.outlineGroup.appendChild(
        this.makeStrokePath(median, '#DDD', 'hanzi-stroke-outline'),
      );
    }
  }

  /** Animate the character stroke by stroke (Give Up). */
  animateCharacter(perStrokeMs = 400) {
    this.clearAnimationTimers();
    this.completedGroup.replaceChildren();
    this.medians.forEach((median, i) => {
      const timer = window.setTimeout(() => {
        const pathEl = this.makeStrokePath(
          median,
          '#555',
          'hanzi-stroke-animated',
        );
        const len = pathEl.getTotalLength();
        pathEl.style.strokeDasharray = `${len} ${len}`;
        pathEl.style.strokeDashoffset = String(len);
        pathEl.style.transition = `stroke-dashoffset ${perStrokeMs * 0.9}ms linear`;
        this.completedGroup.appendChild(pathEl);
        // Force a layout so the transition actually runs.
        pathEl.getBoundingClientRect();
        pathEl.style.strokeDashoffset = '0';
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

  private makeGroup(cls: string): SVGGElement {
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add(cls);
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

  /** Round-capped polyline along a median, i.e. a brush-skeleton stroke. */
  private makeStrokePath(
    median: Point[],
    color: string,
    cls: string,
  ): SVGPathElement {
    const pathEl = document.createElementNS(SVG_NS, 'path');
    pathEl.setAttribute(
      'd',
      this.pathString(median.map(p => this.dataToScreen(p))),
    );
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke', color);
    pathEl.setAttribute('stroke-width', String(BRUSH_WIDTH * this.scale));
    pathEl.setAttribute('stroke-linecap', 'round');
    pathEl.setAttribute('stroke-linejoin', 'round');
    pathEl.classList.add(cls);
    return pathEl;
  }

  private svgLocalPoint(evt: PointerEvent): Point {
    const rect = this.svg.getBoundingClientRect();
    return {x: evt.clientX - rect.left, y: evt.clientY - rect.top};
  }

  private onPointerDown = (evt: PointerEvent) => {
    if (!this.quizActive || this.isComplete) return;
    evt.preventDefault();
    // Synthetic events (tests) may carry a pointerId with no active pointer.
    try {
      this.svg.setPointerCapture(evt.pointerId);
    } catch {
      /* ignore */
    }
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
        this.makeStrokePath(
          this.medians[strokeNum],
          '#555',
          'hanzi-stroke-done',
        ),
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
          this.makeStrokePath(
            this.medians[strokeNum],
            '#FF9800',
            'hanzi-stroke-hint',
          ),
        );
      }
    }
  }

  private clearAnimationTimers() {
    for (const t of this.animationTimers) window.clearTimeout(t);
    this.animationTimers = [];
  }
}
