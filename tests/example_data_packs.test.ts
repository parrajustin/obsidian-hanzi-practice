/**
 * Loads the shipped example data packs (examples/data-packs/*.json) and their
 * linked card files from disk, and imports each pack through the settings
 * tab's real file-picker path. Keeps the examples valid as the pack/card
 * formats evolve — if a format change breaks an example, this suite fails.
 */
import * as fs from 'fs';
import * as path from 'path';
import {App, Plugin} from 'obsidian';
import {noticeMessages, Plugin as MockPlugin} from './__mocks__/obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Err, Ok} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {TextEncoder, TextDecoder} from 'util';
import {
  HanziPluginSettings,
  HanziSettingTab,
  resolveBankSources,
} from '../src/settings';
import {parseDataPack} from '../src/utils/data_pack';
import {
  CardType,
  HANZI_BANK,
  parsePracticeList,
} from '../src/utils/practice_list';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

jest.mock('standard-obsidian-lib/src/filesystem/file_util');

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples', 'data-packs');

/** Every example pack and the banks (with card types) it must install. */
const EXAMPLE_PACKS: {file: string; banks: [string, CardType][]}[] = [
  {file: 'numbers-hanzi.json', banks: [['Numbers', CardType.HANZI]]},
  {file: 'capitals-flashcards.json', banks: [['Capitals', CardType.FLASHCARD]]},
  {
    file: 'german-vocab.json',
    banks: [['German Vocab', CardType.REVERSIBLE_FLASHCARD]],
  },
  {
    file: 'grammar-quiz.json',
    banks: [['Grammar Quiz', CardType.MULTIPLE_CHOICE]],
  },
  {file: 'chinese-sentences.json', banks: [['Sentences', CardType.CLOZE]]},
  {
    file: 'true-false-grammar.json',
    banks: [['Correct or Not', CardType.TRUE_FALSE]],
  },
  {
    file: 'starter-all-types.json',
    banks: [
      ['Numbers', CardType.HANZI],
      ['Capitals', CardType.FLASHCARD],
      ['German Vocab', CardType.REVERSIBLE_FLASHCARD],
      ['Grammar Quiz', CardType.MULTIPLE_CHOICE],
      ['Sentences', CardType.CLOZE],
      ['Correct or Not', CardType.TRUE_FALSE],
    ],
  },
];

const readExample = (file: string) =>
  fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe.each(EXAMPLE_PACKS)('example pack $file', ({file, banks}) => {
  it('parses as a valid data pack naming the expected banks', () => {
    const result = parseDataPack(readExample(file));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.name).toBeTruthy();
      expect(result.val.banks.map(b => b.name)).toEqual(
        banks.map(([name]) => name),
      );
    }
  });

  it('links card files that exist and hold cards of the advertised type', () => {
    const result = parseDataPack(readExample(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const [i, bank] of result.val.banks.entries()) {
      const [expectedName, expectedType] = banks[i];
      expect(bank.name).toBe(expectedName);
      // Pack file paths are vault-relative; the examples dir plays the vault.
      const markdown = readExample(bank.filePath);
      const entries = parsePracticeList(markdown);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.cardType).toBe(expectedType);
        expect(entry.bank).toBe(expectedName);
        // The example lines leave the id field empty — loading derives it.
        expect(entry.id).toMatch(/^[0-9a-f]{8}$/);
      }
    }
  });
});

describe('installing the example packs through the settings file picker', () => {
  let tab: HanziSettingTab;
  let settings: HanziPluginSettings;
  let saveSettings: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    noticeMessages.length = 0;
    (FileUtil.writeToFile as jest.Mock).mockResolvedValue(Ok(undefined));
    settings = {
      version: 2,
      historyFilePath: 'hanzi-practice-history.md',
      practiceFilePath: 'hanzi-practice-words.md',
      banks: [],
      dataPacks: [],
    };
    saveSettings = jest.fn().mockResolvedValue(undefined);
    tab = new HanziSettingTab(
      new App(),
      new MockPlugin() as unknown as Plugin,
      settings,
      saveSettings,
    );
    tab.display();
  });

  it.each(EXAMPLE_PACKS)(
    'picking $file copies it into the vault and registers it',
    async ({file, banks}) => {
      const packJson = readExample(file);
      const packFile = new File([packJson], file, {
        type: 'application/json',
      });
      // jsdom 20 lacks the web-standard Blob.text() the tab reads with.
      Object.defineProperty(packFile, 'text', {
        value: () => Promise.resolve(packJson),
      });
      const fileInput = tab.containerEl.querySelector(
        '.hanzi-pack-file-input',
      ) as HTMLInputElement;
      Object.defineProperty(fileInput, 'files', {
        value: [packFile],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event('change'));
      await flush();
      await flush();

      // The pack is registered by path — its banks are NOT copied into the
      // settings; they resolve from the vault JSON on every load.
      expect(settings.dataPacks).toEqual([{filePath: file}]);
      expect(settings.banks).toEqual([]);
      expect(FileUtil.writeToFile).toHaveBeenCalledWith(
        expect.anything(),
        file,
        new TextEncoder().encode(packJson),
        expect.anything(),
      );
      expect(saveSettings).toHaveBeenCalledWith(settings);
      expect(noticeMessages.at(-1)).toContain('Installed data pack');
      expect(noticeMessages.at(-1)).toContain(
        `${banks.length} bank${banks.length === 1 ? '' : 's'}`,
      );
    },
  );
});

describe('resolving banks from registered example packs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Serve every vault read from the examples directory, so the registered
    // pack JSON and its linked card files both resolve like a real vault.
    (FileUtil.fetchFile as jest.Mock).mockImplementation(
      (_app: unknown, filePath: string) => {
        const full = path.join(EXAMPLES_DIR, filePath);
        if (!fs.existsSync(full)) {
          return Promise.resolve(Err(NotFoundError(`missing ${filePath}`)));
        }
        return Promise.resolve(
          Ok(new TextEncoder().encode(fs.readFileSync(full, 'utf8'))),
        );
      },
    );
  });

  it.each(EXAMPLE_PACKS)(
    'a registered $file contributes its banks at resolution time',
    async ({file, banks}) => {
      const {sources, packErrors} = await resolveBankSources(new App(), {
        version: 2,
        historyFilePath: 'hanzi-practice-history.md',
        practiceFilePath: 'hanzi-practice-words.md',
        banks: [],
        dataPacks: [{filePath: file}],
      });
      expect(packErrors).toEqual([]);
      expect(sources.map(s => s.name)).toEqual([
        HANZI_BANK,
        ...banks.map(([name]) => name),
      ]);
    },
  );
});
