import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Err, Ok} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {TextEncoder, TextDecoder} from 'util';
import {
  HanziPluginSettings,
  resolveBankSources,
  SETTINGS_SCHEMA,
} from '../src/settings';
import {HANZI_BANK} from '../src/utils/practice_list';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

jest.mock('standard-obsidian-lib/src/filesystem/file_util');

describe('settings schema', () => {
  it('migrates v0 settings all the way to v2', () => {
    const res = SETTINGS_SCHEMA.updateSchema({
      version: 0,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val).toEqual({
        version: 2,
        historyFilePath: 'h.md',
        practiceFilePath: 'p.md',
        banks: [],
        dataPacks: [],
      });
    }
  });

  it('migrates v1 settings to v2, keeping imported banks as manual banks', () => {
    const res = SETTINGS_SCHEMA.updateSchema({
      version: 1,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
      banks: [{name: 'Capitals', filePath: 'capitals.md'}],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val).toEqual({
        version: 2,
        historyFilePath: 'h.md',
        practiceFilePath: 'p.md',
        banks: [{name: 'Capitals', filePath: 'capitals.md'}],
        dataPacks: [],
      });
    }
  });

  it('accepts v2 settings with data packs unchanged', () => {
    const v2 = {
      version: 2,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
      banks: [{name: 'Capitals', filePath: 'capitals.md'}],
      dataPacks: [{filePath: 'starter-pack.json'}],
    };
    const res = SETTINGS_SCHEMA.updateSchema(v2);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.val).toEqual(v2);
  });

  it('default settings are v2 with no banks and no packs', () => {
    const res = SETTINGS_SCHEMA.getDefault();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val.version).toBe(2);
      expect(res.val.banks).toEqual([]);
      expect(res.val.dataPacks).toEqual([]);
    }
  });
});

describe('resolveBankSources', () => {
  const makeSettings = (
    banks: HanziPluginSettings['banks'],
    dataPacks: HanziPluginSettings['dataPacks'],
  ): HanziPluginSettings => ({
    version: 2,
    historyFilePath: 'h.md',
    practiceFilePath: 'hanzi.md',
    banks,
    dataPacks,
  });

  const packJson = (banks: {name: string; filePath: string}[]) =>
    Ok(new TextEncoder().encode(JSON.stringify({version: 1, banks})));

  beforeEach(() => jest.clearAllMocks());

  it('lists the Hanzi bank first, then manual banks, with no packs', async () => {
    const {sources, packErrors} = await resolveBankSources(
      new App(),
      makeSettings(
        [
          {name: 'Capitals', filePath: 'capitals.md'},
          {name: 'German', filePath: 'german.md'},
        ],
        [],
      ),
    );
    expect(sources).toEqual([
      {name: HANZI_BANK, filePath: 'hanzi.md'},
      {name: 'Capitals', filePath: 'capitals.md'},
      {name: 'German', filePath: 'german.md'},
    ]);
    expect(packErrors).toEqual([]);
    expect(FileUtil.fetchFile).not.toHaveBeenCalled();
  });

  it("re-reads each registered pack's JSON and appends its banks", async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      packJson([{name: 'German', filePath: 'packs/german-cards.md'}]),
    );
    const {sources, packErrors} = await resolveBankSources(
      new App(),
      makeSettings(
        [{name: 'Capitals', filePath: 'capitals.md'}],
        [{filePath: 'german-pack.json'}],
      ),
    );
    expect(sources).toEqual([
      {name: HANZI_BANK, filePath: 'hanzi.md'},
      {name: 'Capitals', filePath: 'capitals.md'},
      {name: 'German', filePath: 'packs/german-cards.md'},
    ]);
    expect(packErrors).toEqual([]);
    expect(FileUtil.fetchFile).toHaveBeenCalledWith(
      expect.anything(),
      'german-pack.json',
      expect.anything(),
    );
  });

  it('an updated pack JSON re-points its banks on the next resolution', async () => {
    const settings = makeSettings([], [{filePath: 'pack.json'}]);
    (FileUtil.fetchFile as jest.Mock).mockResolvedValueOnce(
      packJson([{name: 'German', filePath: 'v1-cards.md'}]),
    );
    const first = await resolveBankSources(new App(), settings);
    expect(first.sources[1]).toEqual({name: 'German', filePath: 'v1-cards.md'});

    // The pack file changed on disk (sync, manual edit, newer pack version).
    (FileUtil.fetchFile as jest.Mock).mockResolvedValueOnce(
      packJson([{name: 'German', filePath: 'v2-cards.md'}]),
    );
    const second = await resolveBankSources(new App(), settings);
    expect(second.sources[1]).toEqual({
      name: 'German',
      filePath: 'v2-cards.md',
    });
  });

  it('reports unreadable packs without dropping the other banks', async () => {
    (FileUtil.fetchFile as jest.Mock)
      .mockResolvedValueOnce(Err(NotFoundError('no such file')))
      .mockResolvedValueOnce(
        packJson([{name: 'German', filePath: 'german-cards.md'}]),
      );
    const {sources, packErrors} = await resolveBankSources(
      new App(),
      makeSettings(
        [{name: 'Capitals', filePath: 'capitals.md'}],
        [{filePath: 'missing.json'}, {filePath: 'german-pack.json'}],
      ),
    );
    expect(sources.map(s => s.name)).toEqual([
      HANZI_BANK,
      'Capitals',
      'German',
    ]);
    expect(packErrors).toHaveLength(1);
    expect(packErrors[0].filePath).toBe('missing.json');
    expect(packErrors[0].error.message).toContain('no such file');
  });

  it('a pack bank sharing a manual bank name re-points that bank', async () => {
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      packJson([{name: 'Capitals', filePath: 'packs/capitals-cards.md'}]),
    );
    const {sources} = await resolveBankSources(
      new App(),
      makeSettings(
        [{name: 'Capitals', filePath: 'old.md'}],
        [{filePath: 'pack.json'}],
      ),
    );
    expect(sources).toEqual([
      {name: HANZI_BANK, filePath: 'hanzi.md'},
      {name: 'Capitals', filePath: 'packs/capitals-cards.md'},
    ]);
  });
});
