import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Err, Ok} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {TextEncoder, TextDecoder} from 'util';
import {
  DEFAULT_CHARACTER_FILE,
  HanziPluginSettings,
  resolveBankSources,
  SETTINGS_SCHEMA,
} from '../src/settings';
import {CHARACTER_BANK, HANZI_BANK} from '../src/utils/practice_list';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

jest.mock('standard-obsidian-lib/src/filesystem/file_util');

describe('settings schema', () => {
  it('migrates v0 settings all the way to v3', () => {
    const res = SETTINGS_SCHEMA.updateSchema({
      version: 0,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val).toEqual({
        version: 3,
        historyFilePath: 'h.md',
        practiceFilePath: 'p.md',
        banks: [],
        dataPacks: [],
        characterFilePath: DEFAULT_CHARACTER_FILE,
      });
    }
  });

  it('migrates v1 settings to v3, keeping imported banks as manual banks', () => {
    const res = SETTINGS_SCHEMA.updateSchema({
      version: 1,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
      banks: [{name: 'Capitals', filePath: 'capitals.md'}],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val).toEqual({
        version: 3,
        historyFilePath: 'h.md',
        practiceFilePath: 'p.md',
        banks: [{name: 'Capitals', filePath: 'capitals.md'}],
        dataPacks: [],
        characterFilePath: DEFAULT_CHARACTER_FILE,
      });
    }
  });

  it('migrates v2 settings to v3, keeping banks and packs', () => {
    const res = SETTINGS_SCHEMA.updateSchema({
      version: 2,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
      banks: [{name: 'Capitals', filePath: 'capitals.md'}],
      dataPacks: [{filePath: 'starter-pack.json'}],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val).toEqual({
        version: 3,
        historyFilePath: 'h.md',
        practiceFilePath: 'p.md',
        banks: [{name: 'Capitals', filePath: 'capitals.md'}],
        dataPacks: [{filePath: 'starter-pack.json'}],
        // Generated, so an existing config just gets the default path; the
        // file itself appears at the first sync.
        characterFilePath: DEFAULT_CHARACTER_FILE,
      });
    }
  });

  it('accepts v3 settings unchanged', () => {
    const v3 = {
      version: 3,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
      banks: [],
      dataPacks: [],
      characterFilePath: 'chars.md',
    };
    const res = SETTINGS_SCHEMA.updateSchema(v3);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.val).toEqual(v3);
  });

  it('default settings are v3 with no banks, no packs and a ledger path', () => {
    const res = SETTINGS_SCHEMA.getDefault();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val.version).toBe(3);
      expect(res.val.banks).toEqual([]);
      expect(res.val.dataPacks).toEqual([]);
      expect(res.val.characterFilePath).toBe(DEFAULT_CHARACTER_FILE);
    }
  });
});

describe('resolveBankSources', () => {
  const makeSettings = (
    banks: HanziPluginSettings['banks'],
    dataPacks: HanziPluginSettings['dataPacks'],
  ): HanziPluginSettings => ({
    version: 3,
    historyFilePath: 'h.md',
    practiceFilePath: 'hanzi.md',
    banks,
    dataPacks,
    // Off by default in these fixtures so the bank-ordering assertions stay
    // about packs; the ledger bank has its own test.
    characterFilePath: '',
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

  it('resolves the generated character ledger as a practiceable bank', async () => {
    const {sources} = await resolveBankSources(new App(), {
      ...makeSettings([{name: 'Capitals', filePath: 'capitals.md'}], []),
      characterFilePath: 'hanzi-character-progress.md',
    });
    // Right after Hanzi, before the user's own banks: it is generated, not
    // configured, and the practice modal lists it in this order.
    expect(sources).toEqual([
      {name: HANZI_BANK, filePath: 'hanzi.md'},
      {name: CHARACTER_BANK, filePath: 'hanzi-character-progress.md'},
      {name: 'Capitals', filePath: 'capitals.md'},
    ]);
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
