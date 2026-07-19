import { strokeMatches } from '../src/writer/stroke_matcher';
import { Point } from '../src/writer/geometry';

// Real medians for 好 (from hanzi-writer-data), in data space.
const HAO_MEDIANS: number[][][] = [
  [[282, 788], [307, 769], [327, 733], [264, 465], [216, 321], [235, 298], [386, 194], [411, 166], [424, 133]],
  [[390, 556], [417, 530], [424, 516], [422, 504], [387, 361], [338, 255], [304, 207], [260, 165], [206, 127], [137, 97]],
  [[59, 457], [107, 434], [373, 491], [380, 501]],
  [[493, 656], [517, 646], [550, 644], [680, 692], [706, 699], [743, 696], [771, 669], [765, 657], [677, 546], [674, 535], [663, 536]],
  [[613, 530], [637, 519], [659, 499], [674, 474], [687, 432], [711, 289], [709, 166], [692, 92], [672, 59], [648, 41], [551, 85]],
  [[449, 384], [504, 377], [860, 427], [906, 426], [960, 412]],
];

const toPoints = (m: number[][]): Point[] => m.map(([x, y]) => ({ x, y }));

describe('strokeMatches', () => {
  it('accepts a stroke drawn exactly along the median', () => {
    for (let i = 0; i < HAO_MEDIANS.length; i++) {
      expect(strokeMatches(toPoints(HAO_MEDIANS[i]), toPoints(HAO_MEDIANS[i]), i)).toBe(true);
    }
  });

  it('accepts a jittered version of the median (human-like imprecision)', () => {
    const median = toPoints(HAO_MEDIANS[0]);
    const jittered = median.map((p, i) => ({
      x: p.x + (i % 2 === 0 ? 20 : -20),
      y: p.y + (i % 3 === 0 ? -20 : 20),
    }));
    expect(strokeMatches(jittered, median, 0)).toBe(true);
  });

  it('rejects a stroke drawn backwards', () => {
    const median = toPoints(HAO_MEDIANS[0]);
    expect(strokeMatches([...median].reverse(), median, 0)).toBe(false);
  });

  it('rejects drawing the wrong stroke', () => {
    // Drawing stroke 5 (the long horizontal of 子) when stroke 0 is expected.
    expect(strokeMatches(toPoints(HAO_MEDIANS[5]), toPoints(HAO_MEDIANS[0]), 0)).toBe(false);
  });

  it('rejects a short scribble far from the stroke', () => {
    const scribble: Point[] = [{ x: 950, y: 850 }, { x: 960, y: 860 }, { x: 970, y: 850 }];
    expect(strokeMatches(scribble, toPoints(HAO_MEDIANS[0]), 0)).toBe(false);
  });

  it('rejects fewer than two distinct points', () => {
    const median = toPoints(HAO_MEDIANS[0]);
    expect(strokeMatches([{ x: 282, y: 788 }, { x: 282, y: 788 }], median, 0)).toBe(false);
    expect(strokeMatches([], median, 0)).toBe(false);
  });
});
