import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { SchemaManager } from 'standard-obsidian-lib/src/schema/schema';
import { z } from 'zod';
import { Ok } from 'standard-ts-lib/src/result';

const v0Schema = z.object({
  version: z.literal(0),
  historyFilePath: z.string(),
  practiceFilePath: z.string(),
});

export type HanziPluginSettings = z.infer<typeof v0Schema>;

export const SETTINGS_SCHEMA = new SchemaManager<[HanziPluginSettings], 0>(
  'HanziPluginSettings',
  [v0Schema],
  [],
  () => ({
    version: 0,
    historyFilePath: 'hanzi-practice-history.md',
    practiceFilePath: 'hanzi-practice-words.md',
  })
);

export class HanziSettingTab extends PluginSettingTab {
  plugin: Plugin;
  settings: HanziPluginSettings;
  saveSettings: (settings: HanziPluginSettings) => Promise<void>;

  constructor(
    app: App,
    plugin: Plugin,
    settings: HanziPluginSettings,
    saveSettings: (settings: HanziPluginSettings) => Promise<void>
  ) {
    super(app, plugin);
    this.plugin = plugin;
    this.settings = settings;
    this.saveSettings = saveSettings;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('History File Path')
      .setDesc('Path to the markdown file where practice history is saved.')
      .addText((text) =>
        text
          .setPlaceholder('hanzi-practice-history.md')
          .setValue(this.settings.historyFilePath)
          .onChange(async (value) => {
            this.settings.historyFilePath = value;
            await this.saveSettings(this.settings);
          })
      );

    new Setting(containerEl)
      .setName('Practice File Path')
      .setDesc('Path to the markdown file containing characters to learn.')
      .addText((text) =>
        text
          .setPlaceholder('hanzi-practice-words.md')
          .setValue(this.settings.practiceFilePath)
          .onChange(async (value) => {
            this.settings.practiceFilePath = value;
            await this.saveSettings(this.settings);
          })
      );
  }
}
