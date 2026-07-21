import {App, Modal, Notice, TFile} from 'obsidian';
import HanziPracticePlugin from '../main';
import {HanziPluginSettings} from '../settings';
import {prettifyPinyin} from '../utils/prettify_pinyin';
import {
  formatPracticeEntry,
  parsePracticeList,
  PracticeEntry,
} from '../utils/practice_list';

/**
 * Modal to edit the bank of practice hanzi: lists every entry (character,
 * pretty-tone pinyin, English definition) with a Remove button per row, so a
 * mistakenly-added sense can be taken back out. Removal rewrites the words
 * file (which also migrates any old id-less lines to the current format).
 * History lines for removed entries are left alone — they are a log.
 */
export class EditBankModal extends Modal {
  private plugin: HanziPracticePlugin;
  private settings: HanziPluginSettings;
  private listEl!: HTMLElement;

  constructor(app: App, plugin: HanziPracticePlugin) {
    super(app);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  onOpen() {
    const {contentEl} = this;
    contentEl.empty();
    contentEl.createEl('h2', {text: 'Edit Hanzi Practice Bank'});

    this.listEl = contentEl.createDiv({cls: 'hanzi-bank-list'});
    this.listEl.style.maxHeight = '320px';
    this.listEl.style.overflowY = 'auto';

    void this.renderList();
  }

  private async loadEntries(): Promise<PracticeEntry[]> {
    const file = this.app.vault.getAbstractFileByPath(
      this.settings.practiceFilePath,
    );
    if (!(file instanceof TFile)) return [];
    const text = await this.app.vault.read(file);
    return parsePracticeList(text);
  }

  private async renderList() {
    const entries = await this.loadEntries();
    this.listEl.empty();

    if (entries.length === 0) {
      this.listEl.createEl('p', {
        cls: 'hanzi-bank-empty',
        text: 'No characters in your practice bank yet.',
      });
      return;
    }

    for (const entry of entries) {
      const row = this.listEl.createDiv({cls: 'hanzi-bank-row'});
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '10px';
      row.style.padding = '6px 4px';
      row.style.borderBottom = '1px solid var(--background-modifier-border)';

      const charEl = row.createEl('span', {
        cls: 'hanzi-bank-char',
        text: entry.character,
      });
      charEl.style.fontSize = '1.6em';

      const pinyinEl = row.createEl('span', {
        cls: 'hanzi-bank-pinyin',
        text: prettifyPinyin(entry.pinyin),
      });
      pinyinEl.style.fontWeight = 'bold';
      pinyinEl.style.minWidth = '3.5em';

      const englishEl = row.createEl('span', {
        cls: 'hanzi-bank-english',
        text: entry.english,
      });
      englishEl.style.flex = '1';
      englishEl.style.overflow = 'hidden';
      englishEl.style.textOverflow = 'ellipsis';
      englishEl.style.whiteSpace = 'nowrap';
      englishEl.style.color = 'var(--text-muted)';
      englishEl.title = entry.english;

      const removeBtn = row.createEl('button', {
        cls: 'hanzi-bank-remove',
        text: 'Remove',
      });
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', () => {
        void this.removeEntry(entry);
      });
    }
  }

  private async removeEntry(entry: PracticeEntry) {
    const file = this.app.vault.getAbstractFileByPath(
      this.settings.practiceFilePath,
    );
    if (!(file instanceof TFile)) return;

    const text = await this.app.vault.read(file);
    const remaining = parsePracticeList(text).filter(e => e.id !== entry.id);
    const newText = remaining.map(formatPracticeEntry).join('\n');
    await this.app.vault.modify(file, newText);

    const label = entry.pinyin
      ? `${entry.character} (${prettifyPinyin(entry.pinyin)})`
      : entry.character;
    new Notice(`Removed ${label} from your practice list.`);
    await this.renderList();
  }

  onClose() {
    const {contentEl} = this;
    contentEl.empty();
  }
}
