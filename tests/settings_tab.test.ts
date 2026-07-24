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
