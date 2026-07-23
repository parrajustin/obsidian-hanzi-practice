import {App, Notice, Plugin, PluginSettingTab, Setting} from 'obsidian';
import {SchemaManager} from 'standard-obsidian-lib/src/schema/schema';
import {Ok} from 'standard-ts-lib/src/result';
import {z} from 'zod';
import {BankSource, HANZI_BANK} from './utils/practice_list';
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

export type HanziPluginSettings = z.infer<typeof v1Schema>;

export const SETTINGS_SCHEMA = new SchemaManager<
  [V0Settings, HanziPluginSettings],
  1
>(
  'HanziPluginSettings',
  [v0Schema, v1Schema],
  // v0 -> v1: banks were introduced; older configs simply have none.
  [(data: V0Settings) => Ok({...data, version: 1 as const, banks: []})],
  () => ({
    version: 1,
    historyFilePath: 'hanzi-practice-history.md',
    practiceFilePath: 'hanzi-practice-words.md',
    banks: [],
  }),
);

/**
 * Every place cards are stored: the Hanzi bank's file first, then each
 * configured bank's own file. This is the read-path input for
 * `HistoryManager.loadAllPracticeEntries` and friends.
 */
export function bankSources(settings: HanziPluginSettings): BankSource[] {
  return [
    {name: HANZI_BANK, filePath: settings.practiceFilePath},
    ...settings.banks.map(b => ({name: b.name, filePath: b.filePath})),
  ];
}

export class HanziSettingTab extends PluginSettingTab {
  plugin: Plugin;
  settings: HanziPluginSettings;
  saveSettings: (settings: HanziPluginSettings) => Promise<void>;

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

    new Setting(containerEl)
      .setName('History File Path')
      .setDesc('Path to the markdown file where practice history is saved.')
      .addText(text =>
        text
          .setPlaceholder('hanzi-practice-history.md')
          .setValue(this.settings.historyFilePath)
          .onChange(async value => {
            this.settings.historyFilePath = value;
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
            await this.saveSettings(this.settings);
          }),
      );

    this.displayBankSettings(containerEl);
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
          this.settings.banks.push({
            name: `Bank ${n}`,
            filePath: `practice-bank-${n}.md`,
          });
          await this.saveSettings(this.settings);
          this.display();
        });
      });
  }

  /**
   * Closing the settings re-parses every bank file (Hanzi + configured), so
   * path changes take effect immediately and the user sees at a glance how
   * many cards each file yielded.
   */
  override hide(): void {
    const sources = bankSources(this.settings);
    void (async () => {
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
      new Notice(`Practice banks parsed — ${parts.join(', ')}`);
    })();
    super.hide();
  }
}
