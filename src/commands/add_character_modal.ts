import { App, Modal, Notice, Setting } from 'obsidian';
import HanziPracticePlugin from '../main';
import { HanziPluginSettings } from '../settings';
import { formatPracticeEntry, parsePracticeList } from '../utils/practice_list';

export class AddCharacterModal extends Modal {
  private character = '';
  private plugin: HanziPracticePlugin;
  private settings: HanziPluginSettings;
  private errorEl!: HTMLElement;

  constructor(app: App, plugin: HanziPracticePlugin) {
    super(app);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Add New Hanzi Character' });

    new Setting(contentEl)
      .setName('Character')
      .setDesc('Enter a single Chinese character to practice')
      .addText((text) =>
        text
          .setPlaceholder('e.g. 汉')
          .onChange((value) => {
            this.character = value;
            this.clearError();
          })
      );

    // Inline error message (hidden until a validation error occurs)
    this.errorEl = contentEl.createEl('p', { cls: 'hanzi-add-error' });
    this.errorEl.style.color = 'var(--text-error)';
    this.errorEl.style.display = 'none';

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText('Add')
        .setCta()
        .onClick(() => {
          if (this.character.trim().length > 0) {
            this.addCharacter(this.character.trim());
          }
        })
    );
  }

  private showError(msg: string) {
    new Notice(msg);
    this.errorEl.setText(msg);
    this.errorEl.style.display = 'block';
  }

  private clearError() {
    this.errorEl.setText('');
    this.errorEl.style.display = 'none';
  }

  async addCharacter(char: string) {
    const filePath = this.settings.practiceFilePath;
    const file = this.app.vault.getAbstractFileByPath(filePath);

    let text = '';
    if (file && file.hasOwnProperty('extension')) { // is TFile
      text = await this.app.vault.read(file as any);
    }

    // Check if character already exists (compare the character field only).
    const existing = parsePracticeList(text);
    if (existing.some((e) => e.character === char)) {
      this.showError(`"${char}" is already in your practice list.`);
      return; // keep the modal open so the user can correct the input
    }

    // Look up pinyin + English ONCE, now, from the CEDICT dictionary and cache
    // them on the practice line so the practice view never needs the dictionary.
    let pinyin = '';
    let english = '';
    const dictRes = await this.plugin.getDictionary();
    if (dictRes.ok) {
      const defs = dictRes.val.simplifiedTrie.search(char);
      if (defs && defs.length > 0) {
        try {
          const parsed = JSON.parse(defs[0]);
          pinyin = (parsed.pinyin as string) ?? '';
          english = (parsed.english as string) ?? '';
        } catch (e) { /* leave empty */ }
      }
      if (!pinyin) {
        new Notice(`Added "${char}", but it was not found in the dictionary.`);
      }
    } else {
      new Notice(`Added "${char}", but the dictionary could not be loaded.`);
    }

    const newLine = formatPracticeEntry({ character: char, pinyin, english });
    const newText = text.trim().length > 0 ? `${text.replace(/\n$/, '')}\n${newLine}` : newLine;

    if (file && file.hasOwnProperty('extension')) {
      await this.app.vault.modify(file as any, newText);
    } else {
      await this.app.vault.create(filePath, newText);
    }

    this.close();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
