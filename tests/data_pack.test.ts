import {
  DataPack,
  mergeDataPackBanks,
  parseDataPack,
} from '../src/utils/data_pack';
import {HANZI_BANK} from '../src/utils/practice_list';

function pack(banks: DataPack['banks'], name?: string): DataPack {
  return {version: 1, name, banks};
}

describe('parseDataPack', () => {
  it('parses a minimal valid pack', () => {
    const result = parseDataPack(
      JSON.stringify({
        version: 1,
        banks: [{name: 'Capitals', filePath: 'packs/capitals-cards.md'}],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.banks).toEqual([
        {name: 'Capitals', filePath: 'packs/capitals-cards.md'},
      ]);
      expect(result.val.name).toBeUndefined();
    }
  });

  it('keeps the optional pack name and tolerates unknown extra keys', () => {
    const result = parseDataPack(
      JSON.stringify({
        version: 1,
        name: 'HSK 1 starter',
        banks: [],
        rules: {future: true},
        somethingNew: 42,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.name).toBe('HSK 1 starter');
      expect(result.val.banks).toEqual([]);
    }
  });

  it('rejects text that is not JSON', () => {
    const result = parseDataPack('not json at all');
    expect(result.ok).toBe(false);
  });

  it('rejects an unsupported version', () => {
    const result = parseDataPack(JSON.stringify({version: 2, banks: []}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.val.message).toContain('version');
    }
  });

  it('rejects a bank entry missing its file path, naming the field', () => {
    const result = parseDataPack(
      JSON.stringify({version: 1, banks: [{name: 'Capitals'}]}),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.val.message).toContain('banks.0.filePath');
    }
  });

  it('rejects empty bank names and file paths', () => {
    const result = parseDataPack(
      JSON.stringify({version: 1, banks: [{name: '', filePath: 'a.md'}]}),
    );
    expect(result.ok).toBe(false);
  });
});

describe('mergeDataPackBanks', () => {
  it('appends banks whose name is not configured yet', () => {
    const merged = mergeDataPackBanks(
      [{name: 'Capitals', filePath: 'capitals.md'}],
      pack([{name: 'German', filePath: 'german.md'}]),
    );
    expect(merged.banks).toEqual([
      {name: 'Capitals', filePath: 'capitals.md'},
      {name: 'German', filePath: 'german.md'},
    ]);
    expect(merged).toMatchObject({
      added: 1,
      updated: 0,
      unchanged: 0,
      skipped: 0,
    });
  });

  it('re-points an existing bank of the same name to the pack file path', () => {
    const merged = mergeDataPackBanks(
      [{name: 'Capitals', filePath: 'old.md'}],
      pack([{name: 'Capitals', filePath: 'packs/new.md'}]),
    );
    expect(merged.banks).toEqual([
      {name: 'Capitals', filePath: 'packs/new.md'},
    ]);
    expect(merged).toMatchObject({added: 0, updated: 1, unchanged: 0});
  });

  it('counts already-identical banks as unchanged', () => {
    const merged = mergeDataPackBanks(
      [{name: 'Capitals', filePath: 'capitals.md'}],
      pack([{name: 'Capitals', filePath: 'capitals.md'}]),
    );
    expect(merged.banks).toEqual([{name: 'Capitals', filePath: 'capitals.md'}]);
    expect(merged).toMatchObject({added: 0, updated: 0, unchanged: 1});
  });

  it('skips banks named after the built-in Hanzi bank', () => {
    const merged = mergeDataPackBanks(
      [],
      pack([
        {name: HANZI_BANK, filePath: 'evil-hanzi.md'},
        {name: 'German', filePath: 'german.md'},
      ]),
    );
    expect(merged.banks).toEqual([{name: 'German', filePath: 'german.md'}]);
    expect(merged).toMatchObject({added: 1, skipped: 1});
  });

  it('never mutates the existing bank list', () => {
    const existing = [{name: 'Capitals', filePath: 'old.md'}];
    mergeDataPackBanks(
      existing,
      pack([{name: 'Capitals', filePath: 'new.md'}]),
    );
    expect(existing).toEqual([{name: 'Capitals', filePath: 'old.md'}]);
  });
});
