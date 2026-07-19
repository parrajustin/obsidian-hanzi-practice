/**
 * Minimal 2D geometry helpers for stroke grading. Ported (simplified) from
 * hanzi-writer's internals so the grading thresholds keep their meaning.
 * All curves are arrays of {x, y} points in hanzi-writer data space
 * (x 0..1024, y -124..900, y-up).
 */

export interface Point {
  x: number;
  y: number;
}

export const subtract = (p1: Point, p2: Point): Point => ({
  x: p1.x - p2.x,
  y: p1.y - p2.y,
});
export const magnitude = (p: Point): number => Math.hypot(p.x, p.y);
export const distance = (p1: Point, p2: Point): number =>
  magnitude(subtract(p1, p2));
export const equals = (p1: Point, p2: Point): boolean =>
  p1.x === p2.x && p1.y === p2.y;

export const average = (arr: number[]): number =>
  arr.reduce((acc, v) => acc + v, 0) / arr.length;

/** Total arc length of a polyline. */
export const curveLength = (points: Point[]): number => {
  let len = 0;
  for (let i = 1; i < points.length; i++)
    len += distance(points[i], points[i - 1]);
  return len;
};

export const cosineSimilarity = (p1: Point, p2: Point): number =>
  (p1.x * p2.x + p1.y * p2.y) / (magnitude(p1) * magnitude(p2));

/** Distance from a point to a line segment. */
export const pointToSegmentDist = (p: Point, a: Point, b: Point): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Min distance from a point to a polyline (checked against every segment). */
export const pointToPolylineDist = (p: Point, polyline: Point[]): number => {
  if (polyline.length === 1) return distance(p, polyline[0]);
  let min = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    const d = pointToSegmentDist(p, polyline[i - 1], polyline[i]);
    if (d < min) min = d;
  }
  return min;
};

/** Average distance from each of `points` to the polyline `curve`. */
export const averageDistanceToPolyline = (
  points: Point[],
  curve: Point[],
): number => average(points.map(p => pointToPolylineDist(p, curve)));

/** Point on the p1->p2 line, `dist` beyond p2. */
const extendPointOnLine = (p1: Point, p2: Point, dist: number): Point => {
  const vect = subtract(p2, p1);
  const norm = dist / magnitude(vect);
  return {x: p2.x + norm * vect.x, y: p2.y + norm * vect.y};
};

/** Discrete Fréchet distance between two curves (rolling-column DP). */
export const frechetDist = (curve1: Point[], curve2: Point[]): number => {
  const long = curve1.length >= curve2.length ? curve1 : curve2;
  const short = curve1.length >= curve2.length ? curve2 : curve1;
  let prevCol: number[] = [];
  for (let i = 0; i < long.length; i++) {
    const curCol: number[] = [];
    for (let j = 0; j < short.length; j++) {
      const d = distance(long[i], short[j]);
      if (i === 0 && j === 0) curCol.push(d);
      else if (j === 0) curCol.push(Math.max(prevCol[0], d));
      else if (i === 0) curCol.push(Math.max(curCol[j - 1], d));
      else
        curCol.push(
          Math.max(Math.min(prevCol[j], prevCol[j - 1], curCol[j - 1]), d),
        );
    }
    prevCol = curCol;
  }
  return prevCol[short.length - 1];
};

/** Break long segments into pieces no longer than maxLen. */
export const subdivideCurve = (curve: Point[], maxLen = 0.05): Point[] => {
  const out = curve.slice(0, 1);
  for (const point of curve.slice(1)) {
    const prev = out[out.length - 1];
    const segLen = distance(point, prev);
    if (segLen > maxLen) {
      const numNew = Math.ceil(segLen / maxLen);
      const newSegLen = segLen / numNew;
      for (let i = 0; i < numNew; i++) {
        out.push(extendPointOnLine(point, prev, -1 * newSegLen * (i + 1)));
      }
    } else {
      out.push(point);
    }
  }
  return out;
};

/** Redraw the curve with numPoints equally spaced along its length. */
export const outlineCurve = (curve: Point[], numPoints = 30): Point[] => {
  const segmentLen = curveLength(curve) / (numPoints - 1);
  const outlined = [curve[0]];
  const remaining = curve.slice(1);
  for (let i = 0; i < numPoints - 2; i++) {
    let last = outlined[outlined.length - 1];
    let remainingDist = segmentLen;
    for (;;) {
      const nextDist = distance(last, remaining[0]);
      if (nextDist < remainingDist) {
        remainingDist -= nextDist;
        last = remaining.shift()!;
      } else {
        outlined.push(
          extendPointOnLine(last, remaining[0], remainingDist - nextDist),
        );
        break;
      }
    }
  }
  outlined.push(curve[curve.length - 1]);
  return outlined;
};

/** Translate + scale a curve into a normalized frame (Procrustes-style). */
export const normalizeCurve = (curve: Point[]): Point[] => {
  const outlined = outlineCurve(curve);
  const mean = {
    x: average(outlined.map(p => p.x)),
    y: average(outlined.map(p => p.y)),
  };
  const translated = outlined.map(p => subtract(p, mean));
  const first = translated[0];
  const last = translated[translated.length - 1];
  const scale = Math.sqrt(
    average([first.x ** 2 + first.y ** 2, last.x ** 2 + last.y ** 2]),
  );
  return subdivideCurve(
    translated.map(p => ({x: p.x / scale, y: p.y / scale})),
  );
};

/** Rotate a curve around the origin. */
export const rotate = (curve: Point[], theta: number): Point[] =>
  curve.map(p => ({
    x: Math.cos(theta) * p.x - Math.sin(theta) * p.y,
    y: Math.sin(theta) * p.x + Math.cos(theta) * p.y,
  }));
