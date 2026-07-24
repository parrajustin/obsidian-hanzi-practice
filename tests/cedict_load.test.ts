/**
 * @jest-environment node
 *
 * `loadDictionary` inflates gzipped dictionaries with the web-standard
 * DecompressionStream (mobile-safe — no Node zlib in shipped code), which
 * jsdom lacks but Node provides.
 */
import * as zlib from 'zlib';
import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Err, Ok} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {CedictParser} from '../src/dictionary/cedict_parser';

jest.mock('standard-obsidian-lib/src/filesystem/file_util', () => ({
  FileUtil: {fetchFile: jest.fn()},
  FileSystemType: {RAW: 'RAW', OBSIDIAN: 'OBSIDIAN'},
}));

const DICT_TEXT = [
  '# CC-CEDICT sample',
  '好 好 [hao3] /good/proper/',
  '漢語 汉语 [han4 yu3] /Chinese language/',
].join('\n');

describe('CedictParser.loadDictionary', () => {
  // FileUtil is mocked, so the app is never touched (and the mock App
  // needs a DOM this node-env file doesn't have).
  const app = {} as App;

  const expectParsed = (parser: CedictParser) => {
    const hits = parser.simplifiedTrie.search('好');
    expect(hits?.some(v => v.includes('good'))).toBe(true);
    expect(parser.traditionalTrie.search('漢語')).not.toBeNull();
  };

  it('parses a plain-text dictionary', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new TextEncoder().encode(DICT_TEXT)),
    );
    const parser = new CedictParser();
    const result = await parser.loadDictionary(app, 'cedict.txt');
    expect(result.ok).toBe(true);
    expectParsed(parser);
  });

  it('detects the gzip magic and inflates before parsing', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new Uint8Array(zlib.gzipSync(DICT_TEXT))),
    );
    const parser = new CedictParser();
    const result = await parser.loadDictionary(app, 'cedict.txt.gz');
    expect(result.ok).toBe(true);
    expectParsed(parser);
  });

  it('bubbles a fetch failure with added context', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Err(NotFoundError('missing dictionary')),
    );
    const result = await new CedictParser().loadDictionary(app, 'nope.gz');
    expect(result.err).toBe(true);
    expect(result.val.toString()).toContain('Failed to load dict');
  });

  it('rejects a corrupt gzip payload', async () => {
    const gzipped = new Uint8Array(zlib.gzipSync(DICT_TEXT));
    gzipped[gzipped.length - 5] ^= 0xff;
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(Ok(gzipped));
    const result = await new CedictParser().loadDictionary(app, 'bad.gz');
    expect(result.err).toBe(true);
  });
});
