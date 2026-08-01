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
import {HanziPluginSettings, HanziSettingTab} from '../src/settings';
import {parseDataPack} from '../src/utils/data_pack';
import {CardType, parsePracticeList} from '../src/utils/practice_list';

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
    file: 'starter-all-types.json',
    banks: [
      ['Numbers', CardType.HANZI],
      ['Capitals', CardType.FLASHCARD],
      ['German Vocab', CardType.REVERSIBLE_FLASHCARD],
      ['Grammar Quiz', CardType.MULTIPLE_CHOICE],
      ['Sentences', CardType.CLOZE],
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

describe('importing the example packs through the settings file picker', () => {
  let tab: HanziSettingTab;
  let settings: HanziPluginSettings;
  let saveSettings: jest.Mock;

  beforeEach(() => {
    noticeMessages.length = 0;
    settings = {
      version: 1,
      historyFilePath: 'hanzi-practice-history.md',
      practiceFilePath: 'hanzi-practice-words.md',
      banks: [],
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
    'picking $file installs its banks',
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

      expect(settings.banks.map(b => b.name)).toEqual(
        banks.map(([name]) => name),
      );
      expect(saveSettings).toHaveBeenCalledWith(settings);
      expect(noticeMessages.at(-1)).toContain('Imported data pack');
      expect(noticeMessages.at(-1)).toContain(`${banks.length} added`);
    },
  );
});
