import {App, Notice, Plugin, PluginSettingTab, Setting} from 'obsidian';
import {
  FileSystemType,
  FileUtil,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {SchemaManager} from 'standard-obsidian-lib/src/schema/schema';
import {Ok} from 'standard-ts-lib/src/result';
import {StatusError} from 'standard-ts-lib/src/status_error';
import {WrapPromise} from 'standard-ts-lib/src/wrap_promise';
import {z} from 'zod';
import {
  loadDataPack,
  mergeDataPackBanks,
  parseDataPack,
} from './utils/data_pack';
import {BankSource, CHARACTER_BANK, HANZI_BANK} from './utils/practice_list';
import {LogError, LogInfo} from './telemetry/telemetry';
import {UiClickLogger} from './telemetry/ui_debug';
import {HistoryManager} from './utils/history_manager';

const v0Schema = z.object({
  version: z.literal(0),
  historyFilePath: z.string(),
  practiceFilePath: z.string(),
});
type V0Settings = z.infer<typeof v0Schema>;

/**
 * A user-defined practice bank: its display name and the vault file its cards
 * are stored in. (The built-in Hanzi bank is NOT in this list — its file is
 * the top-level `practiceFilePath`, kept separate for backward compatibility.)
 */
const bankConfigSchema = z.object({
  name: z.string(),
  filePath: z.string(),
});
export type BankConfig = z.infer<typeof bankConfigSchema>;

const v1Schema = z.object({
  version: z.literal(1),
  historyFilePath: z.string(),
  practiceFilePath: z.string(),
  banks: z.array(bankConfigSchema),
});
type V1Settings = z.infer<typeof v1Schema>;

/**
 * A registered data pack: the vault path of its JSON file. Only the PATH is
 * stored — the pack's banks are re-read from the file on every bank
 * resolution, so updating/syncing the JSON updates the banks without a
 * re-import.
 */
const dataPackConfigSchema = z.object({
  filePath: z.string(),
});
export type DataPackConfig = z.infer<typeof dataPackConfigSchema>;

const v2Schema = z.object({
  version: z.literal(2),
  historyFilePath: z.string(),
  practiceFilePath: z.string(),
  banks: z.array(bankConfigSchema),
  dataPacks: z.array(dataPackConfigSchema),
});

type V2Settings = z.infer<typeof v2Schema>;

/** Where the generated character ledger lives (see utils/character_ledger.ts). */
export const DEFAULT_CHARACTER_FILE = 'hanzi-character-progress.md';

const v3Schema = v2Schema.omit({version: true}).extend({
  version: z.literal(3),
  /**
   * The generated per-character progress file. It is also a practiceable
   * bank (`Characters`), so it is resolved like any other bank.
   */
  characterFilePath: z.string(),
});

export type HanziPluginSettings = z.infer<typeof v3Schema>;

export const SETTINGS_SCHEMA = new SchemaManager<
  [V0Settings, V1Settings, V2Settings, HanziPluginSettings],
  3
>(
  'HanziPluginSettings',
  [v0Schema, v1Schema, v2Schema, v3Schema],
  [
    // v0 -> v1: banks were introduced; older configs simply have none.
    (data: V0Settings) => Ok({...data, version: 1 as const, banks: []}),
    // v1 -> v2: data packs were introduced; older configs have none (banks
    // imported by the old copy-into-settings flow stay as manual banks).
    (data: V1Settings) => Ok({...data, version: 2 as const, dataPacks: []}),
    // v2 -> v3: the character ledger was introduced. It is generated, so an
    // older config just gets the default path; the file appears at the first
    // sync.
    (data: V2Settings) =>
      Ok({
        ...data,
        version: 3 as const,
        characterFilePath: DEFAULT_CHARACTER_FILE,
      }),
  ],
  () => ({
    version: 3,
    historyFilePath: 'hanzi-practice-history.md',
    practiceFilePath: 'hanzi-practice-words.md',
    banks: [],
    dataPacks: [],
    characterFilePath: DEFAULT_CHARACTER_FILE,
  }),
);

/** One registered pack that could not be read/parsed during resolution. */
export interface DataPackError {
  filePath: string;
  error: StatusError;
}

/**
 * One loaded pack's contribution, for UIs that group banks by pack (the
 * practice modal nests a pack's banks under its name so they can be selected
 * together). A bank name contributed by several packs belongs to the LAST
 * one — matching the merge order, where the last pack's file path wins.
 */
export interface PackGroup {
  /** Display name: the pack JSON's `name`, falling back to its file path. */
  name: string;
  filePath: string;
  /** The bank names this pack contributes (never the built-in Hanzi). */
  bankNames: string[];
}

export interface ResolvedBankSources {
  /** The Hanzi bank first, then manual banks, then each pack's banks. */
  sources: BankSource[];
  /** Per-pack grouping of the bank names each loaded pack contributed. */
  packGroups: PackGroup[];
  /** Registered packs that failed to load — their banks are absent. */
  packErrors: DataPackError[];
}

/**
 * Every place cards are stored: the Hanzi bank's file first, then the
 * manually configured banks, then the banks of every registered data pack —
 * re-read from each pack's JSON file NOW, so pack edits (sync, manual, a
 * newer pack version) take effect on the next resolution without any
 * re-import. This is the read-path input for
 * `HistoryManager.loadAllPracticeEntries` and friends.
 */
export async function resolveBankSources(
  app: App,
  settings: HanziPluginSettings,
): Promise<ResolvedBankSources> {
  let banks: BankSource[] = settings.banks.map(b => ({
    name: b.name,
    filePath: b.filePath,
  }));
  const packErrors: DataPackError[] = [];
  const packGroups: PackGroup[] = [];
  for (const pack of settings.dataPacks) {
    const packResult = await loadDataPack(app, pack.filePath);
    if (!packResult.ok) {
      // A broken/missing pack contributes no banks but must not take the
      // rest of the plugin down; the error surfaces via packErrors.
      LogError('Data pack could not be loaded', packResult.val, {
        filePath: pack.filePath,
      });
      packErrors.push({filePath: pack.filePath, error: packResult.val});
      continue;
    }
    banks = mergeDataPackBanks(banks, packResult.val).banks;
    packGroups.push({
      name: packResult.val.name ?? pack.filePath,
      filePath: pack.filePath,
      bankNames: [
        ...new Set(
          packResult.val.banks
            .map(b => b.name)
            .filter(name => name !== HANZI_BANK),
        ),
      ],
    });
  }
  // A bank name contributed by several packs is owned by the LAST of them
  // (the merge above gave it that pack's file path); drop emptied groups.
  const owner = new Map<string, number>();
  packGroups.forEach((group, i) =>
    group.bankNames.forEach(name => owner.set(name, i)),
  );
  const dedupedGroups = packGroups
    .map((group, i) => ({
      ...group,
      bankNames: group.bankNames.filter(name => owner.get(name) === i),
    }))
    .filter(group => group.bankNames.length > 0);
  return {
    sources: [
      {name: HANZI_BANK, filePath: settings.practiceFilePath},
      // The generated ledger is a real bank: the characters a study pack
      // introduced can be drilled like anything else.
      ...(settings.characterFilePath
        ? [{name: CHARACTER_BANK, filePath: settings.characterFilePath}]
        : []),
      ...banks,
    ],
    packGroups: dedupedGroups,
    packErrors,
  };
}

export class HanziSettingTab extends PluginSettingTab {
  plugin: Plugin;
  settings: HanziPluginSettings;
  saveSettings: (settings: HanziPluginSettings) => Promise<void>;

  private uiClicks = new UiClickLogger('settings-tab');

  constructor(
    app: App,
    plugin: Plugin,
    settings: HanziPluginSettings,
    saveSettings: (settings: HanziPluginSettings) => Promise<void>,
  ) {
    super(app, plugin);
    this.plugin = plugin;
    this.settings = settings;
    this.saveSettings = saveSettings;
  }

  display(): void {
    const {containerEl} = this;
    containerEl.empty();
    LogInfo('Settings tab opened', {
      historyFilePath: this.settings.historyFilePath,
      practiceFilePath: this.settings.practiceFilePath,
      banks: this.settings.banks.map(bank => bank.name),
      dataPacks: this.settings.dataPacks.map(pack => pack.filePath),
    });
    // display() runs again on every settings open AND after every bank added
    // or removed, always on this same containerEl — attach() is idempotent so
    // the click listener cannot stack up, and hide() unloads it.
    this.uiClicks.attach(containerEl);

    new Setting(containerEl)
      .setName('History File Path')
      .setDesc('Path to the markdown file where practice history is saved.')
      .addText(text =>
        text
          .setPlaceholder('hanzi-practice-history.md')
          .setValue(this.settings.historyFilePath)
          .onChange(async value => {
            this.settings.historyFilePath = value;
            LogInfo('User action: changed a setting', {
              setting: 'historyFilePath',
              value,
            });
            await this.saveSettings(this.settings);
          }),
      );

    new Setting(containerEl)
      .setName('Hanzi Practice File Path')
      .setDesc(
        'Path to the markdown file storing the Hanzi bank (characters to learn).',
      )
      .addText(text =>
        text
          .setPlaceholder('hanzi-practice-words.md')
          .setValue(this.settings.practiceFilePath)
          .onChange(async value => {
            this.settings.practiceFilePath = value;
            LogInfo('User action: changed a setting', {
              setting: 'practiceFilePath',
              value,
            });
            await this.saveSettings(this.settings);
          }),
      );

    this.displayBankSettings(containerEl);
    this.displayDataPackSettings(containerEl);
  }

  /**
   * The bank manager: a LIST with one row per configured bank (name + storage
   * file path + a remove button), and an "Add Bank" button that appends a new
   * row. Each bank's cards live in their own file, like the Hanzi bank's
   * characters live in `practiceFilePath`.
   */
  private displayBankSettings(containerEl: HTMLElement) {
    new Setting(containerEl).setName('Practice Banks').setHeading();

    this.settings.banks.forEach((bank, i) => {
      const row = new Setting(containerEl).setName(`Bank ${i + 1}`);
      row.settingEl.addClass('hanzi-bank-row-setting');
      row
        .addText(text => {
          text.inputEl.addClass('hanzi-bank-name');
          text
            .setPlaceholder('Bank name')
            .setValue(bank.name)
            .onChange(async value => {
              LogInfo('User action: renamed a bank', {
                setting: 'bank.name',
                from: bank.name,
                to: value,
                filePath: bank.filePath,
              });
              bank.name = value;
              await this.saveSettings(this.settings);
            });
        })
        .addText(text => {
          text.inputEl.addClass('hanzi-bank-path');
          text
            .setPlaceholder('bank-cards.md')
            .setValue(bank.filePath)
            .onChange(async value => {
              LogInfo('User action: repointed a bank file', {
                setting: 'bank.filePath',
                bank: bank.name,
                from: bank.filePath,
                to: value,
              });
              bank.filePath = value;
              await this.saveSettings(this.settings);
            });
        })
        .addExtraButton(btn => {
          btn.extraSettingsEl.addClass('hanzi-bank-delete');
          btn
            .setIcon('trash')
            .setTooltip('Remove this bank (its file is not deleted)')
            .onClick(async () => {
              LogInfo('User action: removed a bank', {
                bank: bank.name,
                filePath: bank.filePath,
                note: 'config only — the card file is left on disk',
              });
              this.settings.banks.splice(i, 1);
              await this.saveSettings(this.settings);
              this.display();
            });
        });
    });

    new Setting(containerEl)
      .setDesc(
        "Each bank stores its cards in its own file, like the Hanzi bank's words file.",
      )
      .addButton(btn => {
        btn.buttonEl.addClass('hanzi-bank-add');
        btn.setButtonText('Add Bank').onClick(async () => {
          const n = this.settings.banks.length + 1;
          const added = {
            name: `Bank ${n}`,
            filePath: `practice-bank-${n}.md`,
          };
          LogInfo('User action: added a bank', {...added});
          this.settings.banks.push(added);
          await this.saveSettings(this.settings);
          this.display();
        });
      });
  }

  /**
   * The data-pack manager: a LIST with one row per REGISTERED pack (the
   * vault path of its JSON file + a remove button), and an Import button
   * (hidden file input) that installs a pack: the picked JSON is copied into
   * the vault and its path registered. Only the path lives in settings — the
   * pack's banks are re-read from the file on every bank resolution, so an
   * updated/synced JSON updates the banks automatically at plugin start.
   */
  private displayDataPackSettings(containerEl: HTMLElement) {
    new Setting(containerEl).setName('Data Packs').setHeading();

    this.settings.dataPacks.forEach((pack, i) => {
      const row = new Setting(containerEl).setName(`Pack ${i + 1}`);
      row.settingEl.addClass('hanzi-pack-row-setting');
      row
        .addText(text => {
          text.inputEl.addClass('hanzi-pack-path');
          text
            .setPlaceholder('my-pack.json')
            .setValue(pack.filePath)
            .onChange(async value => {
              LogInfo('User action: repointed a data pack', {
                setting: 'dataPack.filePath',
                from: pack.filePath,
                to: value,
              });
              pack.filePath = value;
              await this.saveSettings(this.settings);
            });
        })
        .addExtraButton(btn => {
          btn.extraSettingsEl.addClass('hanzi-pack-delete');
          btn
            .setIcon('trash')
            .setTooltip(
              'Unregister this pack (its JSON and card files are not deleted)',
            )
            .onClick(async () => {
              LogInfo('User action: unregistered a data pack', {
                filePath: pack.filePath,
                note: 'config only — the JSON and card files stay on disk',
              });
              this.settings.dataPacks.splice(i, 1);
              await this.saveSettings(this.settings);
              this.display();
            });
        });
    });

    const fileInput = containerEl.createEl('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.addClass('hanzi-pack-file-input');
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      // Reset so picking the same file again fires another change event.
      fileInput.value = '';
      if (!file) return;
      LogInfo('User action: picked a data pack to import', {
        fileName: file.name,
        bytes: file.size,
      });
      void this.importDataPackFile(file);
    });

    new Setting(containerEl)
      .setDesc(
        'Import copies a data-pack .json into the vault and registers it; ' +
          'its banks load from the file, so editing or syncing the JSON ' +
          'updates them automatically.',
      )
      .addButton(btn => {
        btn.buttonEl.addClass('hanzi-pack-import');
        btn.setButtonText('Import').onClick(() => fileInput.click());
      });
  }

  private async importDataPackFile(file: File): Promise<void> {
    const text = await WrapPromise(
      file.text(),
      /*textForUnknown=*/ 'Failed to read data pack file',
    );
    if (!text.ok) {
      LogError(
        'Data pack import failed: could not read picked file',
        text.val,
        {
          fileName: file.name,
        },
      );
      new Notice(`Data pack import failed: ${text.val.message}`);
      return;
    }
    await this.installDataPack(file.name, text.val);
  }

  /**
   * Install a picked pack: validate, copy the JSON into the vault (at the
   * picked file's name), and register that path — re-importing the same
   * file name just overwrites the vault copy. The settings tab is the
   * top-level caller, so errors surface here as Notices.
   */
  async installDataPack(fileName: string, text: string): Promise<void> {
    const pack = parseDataPack(text);
    if (!pack.ok) {
      LogError('Data pack import failed: invalid pack JSON', pack.val, {
        fileName,
      });
      new Notice(`Data pack import failed: ${pack.val.message}`);
      return;
    }
    const filePath = fileName.endsWith('.json') ? fileName : `${fileName}.json`;
    const write = await FileUtil.writeToFile(
      this.app,
      filePath,
      new TextEncoder().encode(text),
      FileSystemType.OBSIDIAN,
    );
    if (!write.ok) {
      LogError(
        'Data pack import failed: could not write pack into vault',
        write.val,
        {
          filePath,
        },
      );
      new Notice(`Data pack import failed: ${write.val.message}`);
      return;
    }
    const already = this.settings.dataPacks.some(p => p.filePath === filePath);
    if (!already) {
      this.settings.dataPacks.push({filePath});
      await this.saveSettings(this.settings);
    }
    const packName = pack.val.name ? ` "${pack.val.name}"` : '';
    const count = pack.val.banks.length;
    new Notice(
      `${already ? 'Updated' : 'Installed'} data pack${packName} at ` +
        `${filePath} — ${count} bank${count === 1 ? '' : 's'}`,
    );
    this.display();
  }

  /**
   * Closing the settings re-parses every bank file (Hanzi + configured), so
   * path changes take effect immediately and the user sees at a glance how
   * many cards each file yielded.
   */
  override hide(): void {
    this.uiClicks.unload();
    void (async () => {
      const {sources, packErrors} = await resolveBankSources(
        this.app,
        this.settings,
      );
      const parts: string[] = [];
      for (const source of sources) {
        const entries = await HistoryManager.loadPracticeEntries(
          this.app,
          source.filePath,
        );
        parts.push(
          `${source.name}: ${entries.length} card${entries.length === 1 ? '' : 's'}`,
        );
      }
      // What the settings the user just edited actually resolve to — the
      // same summary the Notice shows, kept in the log for the report.
      LogInfo('Settings tab closed; banks re-parsed', {
        banks: parts,
        brokenDataPacks: packErrors.map(packError => packError.filePath),
      });
      new Notice(`Practice banks parsed — ${parts.join(', ')}`);
      for (const packError of packErrors) {
        new Notice(
          `Data pack ${packError.filePath} could not be loaded: ` +
            packError.error.message,
        );
      }
    })();
    super.hide();
  }
}
