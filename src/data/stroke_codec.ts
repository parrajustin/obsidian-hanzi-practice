/**
 * Binary codec for the medians-only hanzi stroke database.
 *
 * The quiz writer only ever needs each stroke's MEDIAN (its skeleton polyline):
 * grading compares the user's drawn points against it, and hints/outlines/
 * animations are rendered from it as a round-capped polyline. The glyph outline
 * paths (the bulk of hanzi-writer-data) are therefore not shipped at all.
 *
 * Layout (all integers little-endian):
 *   bytes 0-3   magic "HZS1"
 *   uint32      character count
 *   then one record per character:
 *     uint32    codepoint
 *     uint8     stroke count
 *     per stroke:
 *       uint8   point count
 *       int16*2 per point: x, y   (hanzi-writer data space: x 0..1024, y -124..900, y-up)
 *
 * Coordinates always fit int16; counts fit uint8 (max observed strokes ~64,
 * points per median stay small after simplification).
 */

import {Ok, Err, Result} from 'standard-ts-lib/src/result';
import {
  StatusError,
  InvalidArgumentError,
} from 'standard-ts-lib/src/status_error';

export type Point = {x: number; y: number};
/** One character's medians: strokes -> points -> [x, y]. */
export type CharMedians = number[][][];

const MAGIC = [0x48, 0x5a, 0x53, 0x31]; // "HZS1"

export function encodeStrokeData(
  entries: Map<string, CharMedians>,
): Result<Uint8Array, StatusError> {
  // First pass: size.
  let size = 4 + 4;
  for (const medians of entries.values()) {
    size += 4 + 1;
    for (const stroke of medians) size += 1 + stroke.length * 4;
  }
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let o = 0;
  for (const b of MAGIC) buf[o++] = b;
  view.setUint32(o, entries.size, true);
  o += 4;
  for (const [char, medians] of entries) {
    const cp = char.codePointAt(0);
    if (cp === undefined)
      return Err(InvalidArgumentError('empty character key'));
    if (medians.length > 255)
      return Err(
        InvalidArgumentError(`${char}: too many strokes (${medians.length})`),
      );
    view.setUint32(o, cp, true);
    o += 4;
    buf[o++] = medians.length;
    for (const stroke of medians) {
      if (stroke.length > 255)
        return Err(
          InvalidArgumentError(`${char}: too many points (${stroke.length})`),
        );
      buf[o++] = stroke.length;
      for (const [x, y] of stroke) {
        view.setInt16(o, x, true);
        o += 2;
        view.setInt16(o, y, true);
        o += 2;
      }
    }
  }
  return Ok(buf);
}

/**
 * Random-access reader over the decoded (already gunzipped) binary blob.
 * A single linear scan builds a codepoint -> byte-offset index; each
 * character's medians are decoded on demand, so nothing large is ever
 * materialized up front.
 */
export class StrokeDataReader {
  private view: DataView;
  private bytes: Uint8Array;
  private index = new Map<number, number>();

  /** Validates the HZS1 magic before constructing the reader. */
  static create(bytes: Uint8Array): Result<StrokeDataReader, StatusError> {
    for (let i = 0; i < MAGIC.length; i++) {
      if (bytes[i] !== MAGIC[i])
        return Err(
          InvalidArgumentError('stroke data: bad magic (not an HZS1 blob)'),
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
        const points = bytes[o++];
        o += points * 4;
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

  get(char: string): CharMedians | null {
    const cp = char.codePointAt(0);
    if (cp === undefined) return null;
    let o = this.index.get(cp);
    if (o === undefined) return null;
    o += 4;
    const strokeCount = this.bytes[o++];
    const medians: CharMedians = [];
    for (let s = 0; s < strokeCount; s++) {
      const pointCount = this.bytes[o++];
      const stroke: number[][] = [];
      for (let p = 0; p < pointCount; p++) {
        const x = this.view.getInt16(o, true);
        o += 2;
        const y = this.view.getInt16(o, true);
        o += 2;
        stroke.push([x, y]);
      }
      medians.push(stroke);
    }
    return medians;
  }
}
