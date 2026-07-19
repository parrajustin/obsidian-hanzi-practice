/**
 * Grades a user-drawn stroke against the expected stroke's median polyline.
 *
 * A simplified port of hanzi-writer's `strokeMatches`: the same five checks
 * with the same thresholds (average distance, start/end proximity, segment
 * direction similarity, normalized-shape Fréchet fit, and minimum length),
 * minus the cross-stroke leniency adjustment. One deliberate change: average
 * distance is measured to the median's SEGMENTS rather than its points, which
 * stays accurate after the shipped medians are polyline-simplified.
 */
import {
  Point,
  average,
  averageDistanceToPolyline,
  cosineSimilarity,
  curveLength,
  distance,
  equals,
  frechetDist,
  normalizeCurve,
  rotate,
  subtract,
} from './geometry';

const AVG_DIST_THRESHOLD = 350; // bigger = more lenient
const START_AND_END_DIST_THRESHOLD = 250; // bigger = more lenient
const FRECHET_THRESHOLD = 0.4; // bigger = more lenient
const MIN_LEN_THRESHOLD = 0.35; // smaller = more lenient
const COSINE_SIMILARITY_THRESHOLD = 0; // -1 to 1, smaller = more lenient
const SHAPE_FIT_ROTATIONS = [
  Math.PI / 16,
  Math.PI / 32,
  0,
  -Math.PI / 32,
  -Math.PI / 16,
];

const stripDuplicates = (points: Point[]): Point[] => {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length === 0 || !equals(p, out[out.length - 1])) out.push(p);
  }
  return out;
};

const getEdgeVectors = (points: Point[]): Point[] => {
  const vectors: Point[] = [];
  for (let i = 1; i < points.length; i++)
    vectors.push(subtract(points[i], points[i - 1]));
  return vectors;
};

const directionMatches = (points: Point[], median: Point[]): boolean => {
  const edgeVectors = getEdgeVectors(points);
  const medianVectors = getEdgeVectors(median);
  const similarities = edgeVectors.map(edge =>
    Math.max(...medianVectors.map(mv => cosineSimilarity(mv, edge))),
  );
  return average(similarities) > COSINE_SIMILARITY_THRESHOLD;
};

const shapeFit = (curve1: Point[], curve2: Point[]): boolean => {
  const norm1 = normalizeCurve(curve1);
  const norm2 = normalizeCurve(curve2);
  let minDist = Infinity;
  for (const theta of SHAPE_FIT_ROTATIONS) {
    minDist = Math.min(minDist, frechetDist(norm1, rotate(norm2, theta)));
  }
  return minDist <= FRECHET_THRESHOLD;
};

/**
 * @param userPoints  the drawn stroke, converted to data space
 * @param median     the expected stroke's median polyline
 * @param strokeNum  index of the expected stroke (later strokes are graded
 *                   with a tighter distance threshold, matching hanzi-writer)
 */
export function strokeMatches(
  userPoints: Point[],
  median: Point[],
  strokeNum: number,
): boolean {
  const points = stripDuplicates(userPoints);
  if (points.length < 2) return false;

  const distMod = strokeNum > 0 ? 0.5 : 1;
  const avgDist = averageDistanceToPolyline(points, median);
  if (avgDist > AVG_DIST_THRESHOLD * distMod) return false;

  const startAndEndMatch =
    distance(median[0], points[0]) <= START_AND_END_DIST_THRESHOLD &&
    distance(median[median.length - 1], points[points.length - 1]) <=
      START_AND_END_DIST_THRESHOLD;
  if (!startAndEndMatch) return false;

  if (!directionMatches(points, median)) return false;
  if (!shapeFit(points, median)) return false;

  const lengthMatches =
    (curveLength(points) + 25) / (curveLength(median) + 25) >=
    MIN_LEN_THRESHOLD;
  return lengthMatches;
}
