/**
 * Binary codec for the hanzi stroke database.
 *
 * Each character ships two things per stroke:
 *  - the MEDIAN (skeleton polyline) — grading compares the user's drawn
 *    points against it;
 *  - the OUTLINE (the glyph's filled SVG path, straight from
 *    hanzi-writer-data) — completed strokes / hints / give-up render the real
 *    calligraphic shape instead of a fat median polyline.
 *
 * Outlines are NOT stored as path strings: they are tokenized into commands
 * (M/L/Q/C/Z) at build time. All coordinates — median points and outline
 * command arguments — are stored as zigzag-varint DELTAS from the previous
 * point (per stroke, starting from (0,0)): consecutive path points are close
 * together, so most deltas fit in one byte, roughly halving the raw size
 * versus absolute int16 and gzipping far better. `get()` re-serializes a
 * character's outlines into SVG `d` strings on demand.
 *
 * Layout (integers little-endian, coordinates zigzag-varint deltas):
 *   bytes 0-3   magic "HZS2"
 *   uint32      character count
 *   then one record per character:
 *     uint32    codepoint
 *     uint8     stroke count
 *     per stroke:
 *       uint16  stroke record byte length (everything below)
 *       uint8   median point count
 *       per median point: delta x, delta y
 *       then outline commands until the record ends (absent = no outline):
 *         uint8 opcode (M/L/Q/C/Z), then delta x, delta y per coordinate pair
 *
 * The delta chain runs through medians and outline pairs independently, each
 * restarting at (0,0) per stroke. Data space is hanzi-writer's: x 0..1024,
 * y -124..900, y-up. Counts fit uint8 (max observed strokes ~64, points per
 * median stay small after simplification).
 */

import {Ok, Err, Result} from 'standard-ts-lib/src/result';
import {
  StatusError,
  InvalidArgumentError,
} from 'standard-ts-lib/src/status_error';
import {InjectStatusMsg} from 'standard-ts-lib/src/status_util/inject_status_msg';

export type Point = {x: number; y: number};
/** One character's medians: strokes -> points -> [x, y]. */
export type CharMedians = number[][][];

/**
 * One character's full stroke data: per-stroke medians plus per-stroke glyph
 * outline SVG path strings (empty string when a stroke has no outline).
 */
export type CharStrokeData = {
  medians: CharMedians;
  outlines: string[];
};

const MAGIC = [0x48, 0x5a, 0x53, 0x32]; // "HZS2"

const OPS = ['M', 'L', 'Q', 'C', 'Z'] as const;
const OP_ARG_COUNT = [2, 2, 4, 6, 0];
const OP_CODE = new Map<string, number>(OPS.map((op, i) => [op, i]));

type PathCommand = {op: number; args: number[]};

const PATH_TOKEN_REGEX = /[A-Za-z]|-?\d+(?:\.\d+)?/g;

const COORD_MIN = -32768;
const COORD_MAX = 32767;

/** Append one zigzag-varint encoded integer to `out`. */
function pushVarint(out: number[], value: number) {
  let zigzag = (value << 1) ^ (value >> 31);
  zigzag >>>= 0;
  while (zigzag > 0x7f) {
    out.push((zigzag & 0x7f) | 0x80);
    zigzag >>>= 7;
  }
  out.push(zigzag);
}

/**
 * Tokenize an SVG path string (absolute M/L/Q/C/Z only — all that
 * hanzi-writer-data uses) into opcodes + rounded integer arguments.
 */
function parsePathString(d: string): Result<PathCommand[], StatusError> {
  const tokens = d.match(PATH_TOKEN_REGEX) ?? [];
  const commands: PathCommand[] = [];
  let i = 0;
  while (i < tokens.length) {
    const op = OP_CODE.get(tokens[i]);
    if (op === undefined) {
      return Err(InvalidArgumentError(`unsupported path token "${tokens[i]}"`));
    }
    i++;
    const args: number[] = [];
    for (let a = 0; a < OP_ARG_COUNT[op]; a++, i++) {
      const value = Math.round(Number(tokens[i]));
      if (!Number.isFinite(value) || value < COORD_MIN || value > COORD_MAX) {
        return Err(
          InvalidArgumentError(`path argument out of range in "${d}"`),
        );
      }
      args.push(value);
    }
    commands.push({op, args});
  }
  return Ok(commands);
}

function serializePathCommands(commands: PathCommand[]): string {
  return commands
    .map(c => (c.args.length ? `${OPS[c.op]} ${c.args.join(' ')}` : OPS[c.op]))
    .join(' ');
}

/** Encode one stroke (median + parsed outline) into its record bytes. */
function encodeStroke(
  median: number[][],
  outline: PathCommand[],
): Result<number[], StatusError> {
  const out: number[] = [];
  if (median.length > 255) {
    return Err(InvalidArgumentError(`too many points (${median.length})`));
  }
  out.push(median.length);
  let px = 0;
  let py = 0;
  for (const [x, y] of median) {
    if (x < COORD_MIN || x > COORD_MAX || y < COORD_MIN || y > COORD_MAX) {
      return Err(InvalidArgumentError(`median point out of range (${x},${y})`));
    }
    pushVarint(out, x - px);
    pushVarint(out, y - py);
    px = x;
    py = y;
  }
  px = 0;
  py = 0;
  for (const command of outline) {
    out.push(command.op);
    for (let a = 0; a < command.args.length; a += 2) {
      pushVarint(out, command.args[a] - px);
      pushVarint(out, command.args[a + 1] - py);
      px = command.args[a];
      py = command.args[a + 1];
    }
  }
  if (out.length > 65535) {
    return Err(InvalidArgumentError(`stroke record too long (${out.length})`));
  }
  return Ok(out);
}

export function encodeStrokeData(
  entries: Map<string, CharStrokeData>,
): Result<Uint8Array, StatusError> {
  // Encode every stroke record first so the sizing pass is trivial.
  const encoded = new Map<string, number[][]>();
  let size = 4 + 4;
  for (const [char, data] of entries) {
    if (data.outlines.length !== data.medians.length) {
      return Err(
        InvalidArgumentError(
          `${char}: ${data.medians.length} medians but ${data.outlines.length} outlines`,
        ),
      );
    }
    if (data.medians.length > 255) {
      return Err(
        InvalidArgumentError(
          `${char}: too many strokes (${data.medians.length})`,
        ),
      );
    }
    if (char.codePointAt(0) === undefined) {
      return Err(InvalidArgumentError('empty character key'));
    }
    const strokes: number[][] = [];
    size += 4 + 1;
    for (let s = 0; s < data.medians.length; s++) {
      const commandsResult = parsePathString(data.outlines[s]);
      if (commandsResult.err) {
        return Err(commandsResult.val.with(InjectStatusMsg(char)));
      }
      const strokeResult = encodeStroke(
        data.medians[s],
        commandsResult.safeUnwrap(),
      );
      if (strokeResult.err) {
        return Err(strokeResult.val.with(InjectStatusMsg(char)));
      }
      const record = strokeResult.safeUnwrap();
      strokes.push(record);
      size += 2 + record.length;
    }
    encoded.set(char, strokes);
  }

  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;
  for (const b of MAGIC) buf[o++] = b;
  view.setUint32(o, entries.size, true);
  o += 4;
  for (const [char, strokes] of encoded) {
    view.setUint32(o, char.codePointAt(0)!, true);
    o += 4;
    buf[o++] = strokes.length;
    for (const record of strokes) {
      view.setUint16(o, record.length, true);
      o += 2;
      buf.set(record, o);
      o += record.length;
    }
  }
  return Ok(buf);
}

/**
 * Random-access reader over the decoded (already gunzipped) binary blob.
 * A single linear scan builds a codepoint -> byte-offset index; each
 * character's strokes are decoded on demand, so nothing large is ever
 * materialized up front.
 */
export class StrokeDataReader {
  private view: DataView;
  private bytes: Uint8Array;
  private index = new Map<number, number>();

  /** Validates the HZS2 magic before constructing the reader. */
  static create(bytes: Uint8Array): Result<StrokeDataReader, StatusError> {
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i])
        return Err(
          InvalidArgumentError('stroke data: bad magic (not an HZS2 blob)'),
        );
    }
    return Ok(new StrokeDataReader(bytes));
  }

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = this.view.getUint32(4, true);
    let o = 8;
    for (let c = 0; c < count; c++) {
      const cp = this.view.getUint32(o, true);
      this.index.set(cp, o);
      o += 4;
      const strokes = bytes[o++];
      for (let s = 0; s < strokes; s++) {
        o += 2 + this.view.getUint16(o, true);
      }
    }
  }

  get size(): number {
    return this.index.size;
  }

  has(char: string): boolean {
    const cp = char.codePointAt(0);
    return cp !== undefined && this.index.has(cp);
  }

  /** Read one zigzag-varint starting at `o`; returns [value, nextOffset]. */
  private readVarint(o: number): [number, number] {
    let shift = 0;
    let zigzag = 0;
    for (;;) {
      const byte = this.bytes[o++];
      zigzag |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    zigzag >>>= 0;
    return [(zigzag >>> 1) ^ -(zigzag & 1), o];
  }

  get(char: string): CharStrokeData | null {
    const cp = char.codePointAt(0);
    if (cp === undefined) return null;
    let o = this.index.get(cp);
    if (o === undefined) return null;
    o += 4;
    const strokeCount = this.bytes[o++];
    const medians: CharMedians = [];
    const outlines: string[] = [];
    for (let s = 0; s < strokeCount; s++) {
      const recordEnd = o + 2 + this.view.getUint16(o, true);
      o += 2;
      const pointCount = this.bytes[o++];
      const stroke: number[][] = [];
      let px = 0;
      let py = 0;
      for (let p = 0; p < pointCount; p++) {
        let dx: number;
        let dy: number;
        [dx, o] = this.readVarint(o);
        [dy, o] = this.readVarint(o);
        px += dx;
        py += dy;
        stroke.push([px, py]);
      }
      medians.push(stroke);
      const commands: PathCommand[] = [];
      px = 0;
      py = 0;
      while (o < recordEnd) {
        const op = this.bytes[o++];
        const args: number[] = [];
        for (let a = 0; a < OP_ARG_COUNT[op]; a += 2) {
          let dx: number;
          let dy: number;
          [dx, o] = this.readVarint(o);
          [dy, o] = this.readVarint(o);
          px += dx;
          py += dy;
          args.push(px, py);
        }
        commands.push({op, args});
      }
      outlines.push(commands.length ? serializePathCommands(commands) : '');
    }
    return {medians, outlines};
  }
}
