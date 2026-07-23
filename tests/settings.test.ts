import {bankSources, SETTINGS_SCHEMA} from '../src/settings';
import {HANZI_BANK} from '../src/utils/practice_list';

describe('settings schema', () => {
  it('migrates v0 settings to v1 with an empty bank list', () => {
    const res = SETTINGS_SCHEMA.updateSchema({
      version: 0,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val).toEqual({
        version: 1,
        historyFilePath: 'h.md',
        practiceFilePath: 'p.md',
        banks: [],
      });
    }
  });

  it('accepts v1 settings with banks unchanged', () => {
    const v1 = {
      version: 1,
      historyFilePath: 'h.md',
      practiceFilePath: 'p.md',
      banks: [{name: 'Capitals', filePath: 'capitals.md'}],
    };
    const res = SETTINGS_SCHEMA.updateSchema(v1);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.val).toEqual(v1);
  });

  it('default settings are v1 with no banks', () => {
    const res = SETTINGS_SCHEMA.getDefault();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.val.version).toBe(1);
      expect(res.val.banks).toEqual([]);
    }
  });
});

describe('bankSources', () => {
  it('lists the Hanzi bank (from practiceFilePath) first, then configured banks', () => {
    const sources = bankSources({
      version: 1,
      historyFilePath: 'h.md',
      practiceFilePath: 'hanzi.md',
      banks: [
        {name: 'Capitals', filePath: 'capitals.md'},
        {name: 'German', filePath: 'german.md'},
      ],
    });
    expect(sources).toEqual([
      {name: HANZI_BANK, filePath: 'hanzi.md'},
      {name: 'Capitals', filePath: 'capitals.md'},
      {name: 'German', filePath: 'german.md'},
    ]);
  });
});
