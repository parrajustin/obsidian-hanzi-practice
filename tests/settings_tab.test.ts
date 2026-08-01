import {App, Plugin} from 'obsidian';
// Mock-only exports come from the mock file itself (same module instance —
// jest maps 'obsidian' to this exact path), which the real typings lack.
import {noticeMessages, Plugin as MockPlugin} from './__mocks__/obsidian';
import {HanziPluginSettings, HanziSettingTab} from '../src/settings';
import {HistoryManager} from '../src/utils/history_manager';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('HanziSettingTab', () => {
  let tab: HanziSettingTab;
  let settings: HanziPluginSettings;
  let saveSettings: jest.Mock;

  const input = (selector: string, index = 0) =>
    tab.containerEl.querySelectorAll(selector)[index] as HTMLInputElement;

  const type = (el: HTMLInputElement, value: string) => {
    el.value = value;
    el.dispatchEvent(new Event('input', {bubbles: true}));
  };

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

  it('edits to the file-path fields save the settings', async () => {
    const historyInput = tab.containerEl.querySelector(
      'input',
    ) as HTMLInputElement;
    type(historyInput, 'elsewhere.md');
    await flush();
    expect(settings.historyFilePath).toBe('elsewhere.md');
    expect(saveSettings).toHaveBeenCalledWith(settings);
  });

  it('Add Bank appends a configured bank and re-renders the list', async () => {
    (
      tab.containerEl.querySelector('.hanzi-bank-add') as HTMLElement
    ).dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(settings.banks).toEqual([
      {name: 'Bank 1', filePath: 'practice-bank-1.md'},
    ]);
    expect(
      tab.containerEl.querySelectorAll('.hanzi-bank-row-setting'),
    ).toHaveLength(1);

    // Rename the new bank + repath it through its row fields.
    type(input('.hanzi-bank-name'), 'Capitals');
    type(input('.hanzi-bank-path'), 'capitals.md');
    await flush();
    expect(settings.banks).toEqual([
      {name: 'Capitals', filePath: 'capitals.md'},
    ]);
  });

  it('the trash button removes only the bank config', async () => {
    settings.banks.push({name: 'Capitals', filePath: 'capitals.md'});
    tab.display();
    (
      tab.containerEl.querySelector('.hanzi-bank-delete') as HTMLElement
    ).dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(settings.banks).toEqual([]);
    expect(
      tab.containerEl.querySelectorAll('.hanzi-bank-row-setting'),
    ).toHaveLength(0);
  });

  it('the Import button opens the hidden data-pack file picker', () => {
    const fileInput = input('.hanzi-pack-file-input');
    const click = jest.spyOn(fileInput, 'click').mockImplementation(() => {});
    (
      tab.containerEl.querySelector('.hanzi-pack-import') as HTMLElement
    ).dispatchEvent(new MouseEvent('click'));
    expect(click).toHaveBeenCalled();
  });

  it('importing a data pack merges its banks, saves, and re-renders', async () => {
    settings.banks.push({name: 'Capitals', filePath: 'old.md'});
    tab.display();
    await tab.importDataPackText(
      JSON.stringify({
        version: 1,
        name: 'Starter',
        banks: [
          {name: 'Capitals', filePath: 'packs/capitals-cards.md'},
          {name: 'German', filePath: 'packs/german-cards.md'},
        ],
      }),
    );
    expect(settings.banks).toEqual([
      {name: 'Capitals', filePath: 'packs/capitals-cards.md'},
      {name: 'German', filePath: 'packs/german-cards.md'},
    ]);
    expect(saveSettings).toHaveBeenCalledWith(settings);
    expect(noticeMessages.at(-1)).toContain('Imported data pack "Starter"');
    expect(noticeMessages.at(-1)).toContain('1 added');
    expect(noticeMessages.at(-1)).toContain('1 updated');
    // The bank list re-rendered with the imported rows.
    expect(
      tab.containerEl.querySelectorAll('.hanzi-bank-row-setting'),
    ).toHaveLength(2);
  });

  it('an invalid data pack leaves the settings untouched', async () => {
    await tab.importDataPackText('{"version": 999}');
    expect(settings.banks).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(noticeMessages.at(-1)).toContain('Data pack import failed');
  });

  it('picking a pack file imports it through the change handler', async () => {
    const fileInput = input('.hanzi-pack-file-input');
    const packJson = JSON.stringify({
      version: 1,
      banks: [{name: 'German', filePath: 'german-cards.md'}],
    });
    const file = new File([packJson], 'pack.json', {
      type: 'application/json',
    });
    // jsdom 20 lacks the web-standard Blob.text() the tab reads with.
    Object.defineProperty(file, 'text', {
      value: () => Promise.resolve(packJson),
    });
    Object.defineProperty(fileInput, 'files', {
      value: [file],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    // file.text() resolves over several microtasks; flush a macrotask twice.
    await flush();
    await flush();
    expect(settings.banks).toEqual([
      {name: 'German', filePath: 'german-cards.md'},
    ]);
    expect(noticeMessages.at(-1)).toContain('1 added');
  });

  it('hide() re-parses every bank file and notices the counts', async () => {
    settings.banks.push({name: 'Capitals', filePath: 'capitals.md'});
    const load = jest
      .spyOn(HistoryManager, 'loadPracticeEntries')
      .mockResolvedValue([]);
    tab.hide();
    await flush();
    expect(load).toHaveBeenCalledTimes(2); // Hanzi words file + Capitals
    expect(noticeMessages.at(-1)).toContain('Hanzi: 0 cards');
    expect(noticeMessages.at(-1)).toContain('Capitals: 0 cards');
  });
});
