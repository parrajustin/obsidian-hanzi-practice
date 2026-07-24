/**
 * @jest-environment node
 *
 * Node environment: the loader inflates via the web-standard
 * DecompressionStream, which jsdom lacks but Node provides.
 */
import * as zlib from 'zlib';
import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Err, Ok} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {loadStrokeData} from '../src/data/stroke_data';
import {CharStrokeData, encodeStrokeData} from '../src/data/stroke_codec';

jest.mock('standard-obsidian-lib/src/filesystem/file_util', () => ({
  FileUtil: {fetchFile: jest.fn()},
  FileSystemType: {RAW: 'RAW', OBSIDIAN: 'OBSIDIAN'},
}));

const hao: CharStrokeData = {
  medians: [
    [
      [282, 788],
      [264, 465],
    ],
  ],
  outlines: ['M 282 788 L 264 465 Z'],
};

const blob = () => encodeStrokeData(new Map([['好', hao]])).unsafeUnwrap();

describe('loadStrokeData', () => {
  // FileUtil is mocked, so the app is never touched (and the mock App
  // needs a DOM this node-env file doesn't have).
  const app = {} as App;

  it('reads a raw (non-gzipped) HZS2 blob', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(Ok(blob()));
    const reader = await loadStrokeData(app, 'hanzi-strokes.bin');
    expect(reader.ok).toBe(true);
    expect(reader.unsafeUnwrap().get('好')?.medians).toEqual(hao.medians);
  });

  it('detects the gzip magic and inflates before decoding', async () => {
    const gzipped = new Uint8Array(zlib.gzipSync(blob()));
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(Ok(gzipped));
    const reader = await loadStrokeData(app, 'hanzi-strokes.bin.gz');
    expect(reader.ok).toBe(true);
    expect(reader.unsafeUnwrap().get('好')?.outlines).toEqual([
      'M 282 788 L 264 465 Z',
    ]);
  });

  it('bubbles a fetch failure with added context', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Err(NotFoundError('missing file')),
    );
    const reader = await loadStrokeData(app, 'nope.bin.gz');
    expect(reader.err).toBe(true);
    expect(reader.val.toString()).toContain('Failed to load stroke data');
  });

  it('rejects a corrupt gzip payload', async () => {
    const gzipped = new Uint8Array(zlib.gzipSync(blob()));
    gzipped[gzipped.length - 5] ^= 0xff; // flip bits inside the deflate body
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(Ok(gzipped));
    const reader = await loadStrokeData(app, 'corrupt.bin.gz');
    expect(reader.err).toBe(true);
  });

  it('rejects bytes that are not an HZS2 blob', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new TextEncoder().encode('not a stroke database')),
    );
    const reader = await loadStrokeData(app, 'garbage.bin');
    expect(reader.err).toBe(true);
    expect(reader.val.toString()).toContain('bad magic');
  });
});
