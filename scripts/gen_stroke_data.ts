/**
 * Build-time generator for the shipped stroke database.
 *
 * Reads every per-character JSON in node_modules/hanzi-writer-data (a
 * devDependency — it never ships), keeps ONLY the medians, simplifies each
 * median polyline (Douglas-Peucker, epsilon 10 units of the 1024-unit em box —
 * ~1% of the character box, far below the ~250-unit grading thresholds; cuts
 * a third of the points), encodes with the HZS1 binary codec, and gzips the
 * result. Net: 47MB of per-char JSON -> ~1.4MB shipped.
 *
 * Invoked by esbuild.config.mjs (bundled to cjs and run with node):
 *   node gen_stroke_data.cjs <hanzi-writer-data-dir> <out.bin.gz>
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {encodeStrokeData, CharMedians} from '../src/data/stroke_codec';

const SIMPLIFY_EPSILON = 10;

function perpDist(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
  const cx = a[0] + t * dx;
  const cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

function douglasPeucker(points: number[][], epsilon: number): number[][] {
  if (points.length < 3) return points;
  let maxDist = -1;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist <= epsilon) return [first, last];
  const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
  const right = douglasPeucker(points.slice(maxIdx), epsilon);
  return left.slice(0, -1).concat(right);
}

function main() {
  const [dataDir, outPath] = process.argv.slice(2);
  if (!dataDir || !outPath) {
    console.error(
      'usage: gen_stroke_data <hanzi-writer-data-dir> <out.bin.gz>',
    );
    process.exit(1);
  }
  const entries = new Map<string, CharMedians>();
  let rawPoints = 0;
  let keptPoints = 0;
  for (const file of fs.readdirSync(dataDir)) {
    if (!file.endsWith('.json') || file === 'all.json') continue;
    const char = path.basename(file, '.json');
    // Only single-codepoint character files (skip any package metadata json).
    if ([...char].length !== 1) continue;
    const json = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
    if (!Array.isArray(json.medians)) continue;
    const medians: CharMedians = json.medians.map((stroke: number[][]) => {
      rawPoints += stroke.length;
      const simplified = douglasPeucker(stroke, SIMPLIFY_EPSILON).map(
        ([x, y]) => [Math.round(x), Math.round(y)],
      );
      keptPoints += simplified.length;
      return simplified;
    });
    entries.set(char, medians);
  }
  const encodedResult = encodeStrokeData(entries);
  if (encodedResult.err) {
    console.error(
      `stroke data: encode failed: ${encodedResult.val.toString()}`,
    );
    process.exit(1);
  }
  const encoded = encodedResult.safeUnwrap();
  const gz = zlib.gzipSync(encoded, {level: zlib.constants.Z_BEST_COMPRESSION});
  fs.mkdirSync(path.dirname(outPath), {recursive: true});
  fs.writeFileSync(outPath, gz);
  console.log(
    `stroke data: ${entries.size} chars, ${rawPoints} -> ${keptPoints} median points, ` +
      `${(encoded.length / 1e6).toFixed(2)}MB binary -> ${(gz.length / 1e6).toFixed(2)}MB gz`,
  );
}

main();
