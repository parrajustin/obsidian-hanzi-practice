/**
 * @jest-environment node
 *
 * Node environment (not jsdom): jsdom does not expose DecompressionStream,
 * Node >=18 does. Node zlib is used here only to produce the gzip fixture —
 * the code under test must inflate it WITHOUT Node APIs (that is the point:
 * Obsidian mobile has no Node runtime).
 */
import * as zlib from 'zlib';
import {gunzip} from '../src/utils/gunzip';

describe('gunzip (web DecompressionStream)', () => {
  it('round-trips node-gzipped utf-8 data', async () => {
    const original = Buffer.from('好 hao3 good/appropriate 汉字\n'.repeat(500));
    const out = await gunzip(new Uint8Array(zlib.gzipSync(original)));
    expect(out.ok).toBe(true);
    expect(Buffer.from(out.unsafeUnwrap()).equals(original)).toBe(true);
  });

  it('round-trips binary data (stroke-db-like)', async () => {
    const original = Buffer.from(
      Array.from({length: 4096}, (_, i) => (i * 37) % 256),
    );
    const out = await gunzip(new Uint8Array(zlib.gzipSync(original)));
    expect(out.ok).toBe(true);
    expect(Buffer.from(out.unsafeUnwrap()).equals(original)).toBe(true);
  });

  it('returns Err on corrupt gzip input', async () => {
    const bad = new Uint8Array([0x1f, 0x8b, 0x01, 0x02, 0x03, 0x04]);
    const out = await gunzip(bad);
    expect(out.err).toBe(true);
  });
});
