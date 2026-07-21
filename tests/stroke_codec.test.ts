import {
  encodeStrokeData,
  StrokeDataReader,
  CharStrokeData,
} from '../src/data/stroke_codec';

describe('Stroke data codec (HZS2)', () => {
  const hao: CharStrokeData = {
    medians: [
      [
        [282, 788],
        [307, 769],
        [327, 733],
        [264, 465],
      ],
      [
        [139, 512],
        [305, 535],
        [368, 549],
      ],
    ],
    // Real hanzi-writer-data style paths: M/L/Q/C absolute commands + Z.
    outlines: [
      'M 330 202 Q 361 175 399 134 L 424 118 Q 439 128 442 170 Z',
      'M 139 512 C 200 520 250 530 305 535 L 368 549 Z',
    ],
  };
  const han: CharStrokeData = {
    medians: [
      [
        [100, -124],
        [200, 900],
      ], // exercise the extremes of the coordinate range
    ],
    outlines: ['M 100 -124 L 200 900 Z'],
  };
  // Strokes without an outline are allowed (empty string round-trips).
  const zi: CharStrokeData = {
    medians: [
      [
        [10, 20],
        [30, 40],
      ],
    ],
    outlines: [''],
  };

  const roundTrip = (entries: Map<string, CharStrokeData>) =>
    StrokeDataReader.create(
      encodeStrokeData(entries).unsafeUnwrap(),
    ).unsafeUnwrap();

  it('round-trips characters exactly', () => {
    const reader = roundTrip(
      new Map([
        ['好', hao],
        ['汉', han],
      ]),
    );
    expect(reader.size).toBe(2);
    expect(reader.get('好')).toEqual(hao);
    expect(reader.get('汉')).toEqual(han);
  });

  it('handles negative and boundary int16 coordinates', () => {
    const reader = roundTrip(new Map([['汉', han]]));
    expect(reader.get('汉')!.medians[0]).toEqual([
      [100, -124],
      [200, 900],
    ]);
    expect(reader.get('汉')!.outlines[0]).toBe('M 100 -124 L 200 900 Z');
  });

  it('round-trips strokes with no outline as empty strings', () => {
    const reader = roundTrip(new Map([['字', zi]]));
    expect(reader.get('字')).toEqual(zi);
  });

  it('rounds fractional outline coordinates to integers', () => {
    const frac: CharStrokeData = {
      medians: [[[0, 0]]],
      outlines: ['M 10.6 -3.4 L 20 30 Z'],
    };
    const reader = roundTrip(new Map([['好', frac]]));
    expect(reader.get('好')!.outlines[0]).toBe('M 11 -3 L 20 30 Z');
  });

  it('rejects outlines with unsupported path commands', () => {
    const bad: CharStrokeData = {
      medians: [[[0, 0]]],
      outlines: ['M 0 0 A 5 5 0 0 1 10 10'],
    };
    const result = encodeStrokeData(new Map([['好', bad]]));
    expect(result.err).toBe(true);
  });

  it('rejects a medians/outlines length mismatch', () => {
    const mismatched: CharStrokeData = {
      medians: [[[0, 0]], [[1, 1]]],
      outlines: ['M 0 0 Z'],
    };
    const result = encodeStrokeData(new Map([['好', mismatched]]));
    expect(result.err).toBe(true);
  });

  it('returns null for unknown characters', () => {
    const reader = roundTrip(new Map([['好', hao]]));
    expect(reader.get('字')).toBeNull();
    expect(reader.has('字')).toBe(false);
    expect(reader.has('好')).toBe(true);
  });

  it('rejects blobs without the magic header', () => {
    const result = StrokeDataReader.create(
      new Uint8Array([1, 2, 3, 4, 0, 0, 0, 0]),
    );
    expect(result.err).toBe(true);
    expect(result.err && result.val.message).toMatch(/magic/);
  });

  it('supports supplementary-plane characters (surrogate pairs)', () => {
    const rare = '𠀋'; // U+2000B
    const reader = roundTrip(new Map([[rare, han]]));
    expect(reader.get(rare)).toEqual(han);
  });
});
