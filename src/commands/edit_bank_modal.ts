import {App, Modal, Notice, TFile} from 'obsidian';
import HanziPracticePlugin from '../main';
import {bankSources, HanziPluginSettings} from '../settings';
import {prettifyPinyin} from '../utils/prettify_pinyin';
import {
  BankSource,
  entryLabel,
  formatPracticeEntry,
  HANZI_BANK,
  IsFlashcardEntry,
  parsePracticeList,
  PracticeEntry,
} from '../utils/practice_list';

/** A practice entry together with the file it was loaded from. */
interface SourcedEntry {
  source: BankSource;
  entry: PracticeEntry;
}

/**
 * Modal to edit the practice banks: lists every card (hanzi rows show
 * character, pretty-tone pinyin, English definition; flashcard rows show
 * front and back) grouped by bank, with a Remove button per row, so a
 * mistakenly-added card can be taken back out. Each bank is stored in its own
 * file, so removal rewrites THE FILE THE CARD CAME FROM (which also migrates
 * any old-format lines in it to the current format). History lines for
 * removed entries are left alone — they are a log.
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
    contentEl.createEl('h2', {text: 'Edit Practice Banks'});

    this.listEl = contentEl.createDiv({cls: 'hanzi-bank-list'});
    this.listEl.style.maxHeight = '320px';
    this.listEl.style.overflowY = 'auto';

    void this.renderList();
  }

  private async readSourceFile(source: BankSource): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(source.filePath);
    if (!(file instanceof TFile)) return null;
    return await this.app.vault.read(file);
  }

  private async loadEntries(): Promise<SourcedEntry[]> {
    const rows: SourcedEntry[] = [];
    for (const source of bankSources(this.settings)) {
      const text = await this.readSourceFile(source);
      if (text === null) continue;
      for (const entry of parsePracticeList(text)) {
        // The file decides the bank — except legacy lines in the Hanzi file,
        // which keep their own bank tag (see loadAllPracticeEntries).
        if (source.name !== HANZI_BANK) entry.bank = source.name;
        rows.push({source, entry});
      }
    }
    return rows;
  }

  private async renderList() {
    const rows = await this.loadEntries();
    this.listEl.empty();

    if (rows.length === 0) {
      this.listEl.createEl('p', {
        cls: 'hanzi-bank-empty',
        text: 'No cards in your practice banks yet.',
      });
      return;
    }

    // Group rows under a bank heading — but only when there is more than one
    // bank; a single-bank list needs no heading.
    const banks: string[] = [];
    for (const row of rows) {
      if (!banks.includes(row.entry.bank)) banks.push(row.entry.bank);
    }
    for (const bank of banks) {
      if (banks.length > 1) {
        const heading = this.listEl.createEl('h4', {
          cls: 'practice-bank-heading',
          text: bank,
        });
        heading.style.margin = '10px 0 2px';
      }
      for (const row of rows.filter(r => r.entry.bank === bank)) {
        this.renderRow(row);
      }
    }
  }

  private renderRow(sourced: SourcedEntry) {
    const {entry} = sourced;
    const row = this.listEl.createDiv({cls: 'hanzi-bank-row'});
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '10px';
    row.style.padding = '6px 4px';
    row.style.borderBottom = '1px solid var(--background-modifier-border)';

    if (IsFlashcardEntry(entry)) {
      const frontEl = row.createEl('span', {
        cls: 'flash-bank-front',
        text: entry.front,
      });
      frontEl.style.flex = '1';
      frontEl.style.overflow = 'hidden';
      frontEl.style.textOverflow = 'ellipsis';
      frontEl.style.whiteSpace = 'nowrap';
      frontEl.title = entry.front;

      const backEl = row.createEl('span', {
        cls: 'flash-bank-back',
        text: entry.back,
      });
      backEl.style.flex = '1';
      backEl.style.overflow = 'hidden';
      backEl.style.textOverflow = 'ellipsis';
      backEl.style.whiteSpace = 'nowrap';
      backEl.style.color = 'var(--text-muted)';
      backEl.title = entry.back;
    } else {
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
    }

    const removeBtn = row.createEl('button', {
      cls: 'hanzi-bank-remove',
      text: 'Remove',
    });
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
      void this.removeEntry(sourced);
    });
  }

  private async removeEntry(sourced: SourcedEntry) {
    const {source, entry} = sourced;
    const file = this.app.vault.getAbstractFileByPath(source.filePath);
    if (!(file instanceof TFile)) return;

    const text = await this.app.vault.read(file);
    const remaining = parsePracticeList(text).filter(e => e.id !== entry.id);
    const newText = remaining.map(formatPracticeEntry).join('\n');
    await this.app.vault.modify(file, newText);

    // Hanzi notices show pretty-tone pinyin (hǎo, not hao3); flashcards use
    // the generic "front (back)" label.
    const label = IsFlashcardEntry(entry)
      ? entryLabel(entry)
      : entry.pinyin
        ? `${entry.character} (${prettifyPinyin(entry.pinyin)})`
        : entry.character;
    new Notice(`Removed ${label} from your practice bank.`);
    await this.renderList();
  }

  onClose() {
    const {contentEl} = this;
    contentEl.empty();
  }
}
