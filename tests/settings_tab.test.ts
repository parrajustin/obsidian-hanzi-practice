import {App, Plugin} from 'obsidian';
// Mock-only exports come from the mock file itself (same module instance —
// jest maps 'obsidian' to this exact path), which the real typings lack.
import {noticeMessages, Plugin as MockPlugin} from './__mocks__/obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Err, Ok} from 'standard-ts-lib/src/result';
import {NotFoundError} from 'standard-ts-lib/src/status_error';
import {TextEncoder, TextDecoder} from 'util';
import {HanziPluginSettings, HanziSettingTab} from '../src/settings';
import {InitTelemetry, ResetTelemetry} from '../src/telemetry/telemetry';
import {HistoryManager} from '../src/utils/history_manager';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

jest.mock('standard-obsidian-lib/src/filesystem/file_util');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const STARTER_PACK = JSON.stringify({
  version: 1,
  name: 'Starter',
  banks: [
    {name: 'Capitals', filePath: 'packs/capitals-cards.md'},
    {name: 'German', filePath: 'packs/german-cards.md'},
  ],
});

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
    jest.clearAllMocks();
    noticeMessages.length = 0;
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Err(NotFoundError('no such file')),
    );
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

  describe('click logging is registered, not leaked', () => {
    /**
     * The settings tab is NOT an Obsidian Component, so its click logger owns
     * one — and `display()` re-runs on every settings open AND after every
     * bank added or removed, on the SAME containerEl. A plain
     * addEventListener would therefore stack up one listener per render (and
     * survive the tab closing).
     */
    const clickLogs = () =>
      logs.filter(entry => entry.message === 'User clicked');

    let logs: Array<{message: string; data: Record<string, unknown>}>;

    beforeEach(() => {
      logs = [];
      ResetTelemetry();
      window.bugCollector = {
        apiVersion: 3,
        register: () => ({
          pluginId: 'hanzi-practice',
          pluginVersion: '1.0.0',
          getBaggage: () => ({}),
          setBaggage: () => {},
          log: (
            _level: string,
            message: string,
            data: Record<string, unknown>,
          ) => void logs.push({message, data}),
          getTracer: () => ({}),
          getMeter: () => ({
            createCounter: () => ({add: () => {}}),
            createHistogram: () => ({record: () => {}}),
            createObservableGauge: () => ({addCallback: () => {}}),
          }),
          start: () => {},
          restart: () => {},
          end: () => {},
          startGroup: () => 'group',
          endGroup: () => {},
        }),
      } as never;
      InitTelemetry('test');
    });

    afterEach(() => {
      ResetTelemetry();
      delete window.bugCollector;
    });

    it('logs a click once, no matter how often the tab re-renders', () => {
      tab.display();
      tab.display();
      tab.display();

      (
        tab.containerEl.querySelector('.hanzi-bank-add') as HTMLElement
      ).dispatchEvent(new MouseEvent('click', {bubbles: true}));

      expect(clickLogs()).toHaveLength(1);
      expect(clickLogs()[0].data).toMatchObject({
        surface: 'settings-tab',
        classes: ['hanzi-bank-add'],
      });
    });

    it('stops logging once the tab is closed', () => {
      tab.display();
      const addButton = tab.containerEl.querySelector(
        '.hanzi-bank-add',
      ) as HTMLElement;

      tab.hide();
      addButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));

      expect(clickLogs()).toHaveLength(0);
    });
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

  it('installing a pack copies its JSON into the vault and registers the path', async () => {
    await tab.installDataPack('starter.json', STARTER_PACK);

    // The JSON is written into the vault, NOT merged into the banks — the
    // pack's banks resolve from the file, so future JSON updates apply.
    expect(FileUtil.writeToFile).toHaveBeenCalledWith(
      expect.anything(),
      'starter.json',
      new TextEncoder().encode(STARTER_PACK),
      expect.anything(),
    );
    expect(settings.dataPacks).toEqual([{filePath: 'starter.json'}]);
    expect(settings.banks).toEqual([]);
    expect(saveSettings).toHaveBeenCalledWith(settings);
    expect(noticeMessages.at(-1)).toContain(
      'Installed data pack "Starter" at starter.json — 2 banks',
    );
    // The registered pack renders as a row like the bank list.
    expect(
      tab.containerEl.querySelectorAll('.hanzi-pack-row-setting'),
    ).toHaveLength(1);
    expect(input('.hanzi-pack-path').value).toBe('starter.json');
  });

  it('re-importing the same file updates the vault copy without a duplicate row', async () => {
    await tab.installDataPack('starter.json', STARTER_PACK);
    saveSettings.mockClear();
    await tab.installDataPack('starter.json', STARTER_PACK);
    expect(settings.dataPacks).toEqual([{filePath: 'starter.json'}]);
    expect(saveSettings).not.toHaveBeenCalled(); // path already registered
    expect(noticeMessages.at(-1)).toContain('Updated data pack');
  });

  it('appends .json to a picked file name that lacks it', async () => {
    await tab.installDataPack('starter', STARTER_PACK);
    expect(settings.dataPacks).toEqual([{filePath: 'starter.json'}]);
  });

  it('an invalid data pack installs nothing', async () => {
    await tab.installDataPack('bad.json', '{"version": 999}');
    expect(FileUtil.writeToFile).not.toHaveBeenCalled();
    expect(settings.dataPacks).toEqual([]);
    expect(saveSettings).not.toHaveBeenCalled();
    expect(noticeMessages.at(-1)).toContain('Data pack import failed');
  });

  it('a failed vault write installs nothing', async () => {
    (FileUtil.writeToFile as jest.Mock).mockResolvedValue(
      Err(NotFoundError('read-only vault')),
    );
    await tab.installDataPack('starter.json', STARTER_PACK);
    expect(settings.dataPacks).toEqual([]);
    expect(noticeMessages.at(-1)).toContain('Data pack import failed');
  });

  it('picking a pack file installs it through the change handler', async () => {
    const fileInput = input('.hanzi-pack-file-input');
    const file = new File([STARTER_PACK], 'starter.json', {
      type: 'application/json',
    });
    // jsdom 20 lacks the web-standard Blob.text() the tab reads with.
    Object.defineProperty(file, 'text', {
      value: () => Promise.resolve(STARTER_PACK),
    });
    Object.defineProperty(fileInput, 'files', {
      value: [file],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change'));
    // file.text() resolves over several microtasks; flush a macrotask twice.
    await flush();
    await flush();
    expect(settings.dataPacks).toEqual([{filePath: 'starter.json'}]);
    expect(noticeMessages.at(-1)).toContain('Installed data pack');
  });

  it('editing a pack row path saves; the trash button unregisters it', async () => {
    settings.dataPacks.push({filePath: 'starter.json'});
    tab.display();
    type(input('.hanzi-pack-path'), 'packs/starter.json');
    await flush();
    expect(settings.dataPacks).toEqual([{filePath: 'packs/starter.json'}]);
    expect(saveSettings).toHaveBeenCalledWith(settings);

    (
      tab.containerEl.querySelector('.hanzi-pack-delete') as HTMLElement
    ).dispatchEvent(new MouseEvent('click'));
    await flush();
    expect(settings.dataPacks).toEqual([]);
    expect(
      tab.containerEl.querySelectorAll('.hanzi-pack-row-setting'),
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

  it("hide() includes registered packs' banks and reports broken packs", async () => {
    settings.dataPacks.push(
      {filePath: 'german-pack.json'},
      {filePath: 'missing.json'},
    );
    (FileUtil.fetchFile as jest.Mock).mockImplementation(
      (_app: unknown, path: string) =>
        Promise.resolve(
          path === 'german-pack.json'
            ? Ok(
                new TextEncoder().encode(
                  JSON.stringify({
                    version: 1,
                    banks: [{name: 'German', filePath: 'german-cards.md'}],
                  }),
                ),
              )
            : Err(NotFoundError('no such file')),
        ),
    );
    const load = jest
      .spyOn(HistoryManager, 'loadPracticeEntries')
      .mockResolvedValue([]);
    tab.hide();
    await flush();
    expect(load).toHaveBeenCalledTimes(2); // Hanzi words file + pack's German
    expect(
      noticeMessages.some(
        m => m.includes('Hanzi: 0 cards') && m.includes('German: 0 cards'),
      ),
    ).toBe(true);
    expect(
      noticeMessages.some(
        m => m.includes('missing.json') && m.includes('could not be loaded'),
      ),
    ).toBe(true);
  });
});
