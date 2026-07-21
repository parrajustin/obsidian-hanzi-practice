import {
  encodeStrokeData,
  StrokeDataReader,
  CharMedians,
} from '../src/data/stroke_codec';

describe('Stroke data codec (HZS1)', () => {
  const hao: CharMedians = [
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
  ];
  const han: CharMedians = [
    [
      [100, -124],
      [200, 900],
    ], // exercise the extremes of the coordinate range
  ];

  const roundTrip = (entries: Map<string, CharMedians>) =>
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
    expect(reader.get('汉')![0]).toEqual([
      [100, -124],
      [200, 900],
    ]);
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
