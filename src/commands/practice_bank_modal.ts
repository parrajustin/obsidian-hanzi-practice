import {App, Modal} from 'obsidian';
import HanziPracticePlugin from '../main';
import {bankSources} from '../settings';
import {HistoryManager} from '../utils/history_manager';

/**
 * The `practice` command's modal: lists every bank (the Hanzi bank plus each
 * bank configured in settings — even ones with no cards yet — plus any
 * legacy bank tags found in the files) with its card count; picking one opens
 * the practice view on that bank.
 */
export class PracticeBankModal extends Modal {
  private plugin: HanziPracticePlugin;
  private listEl!: HTMLElement;

  constructor(app: App, plugin: HanziPracticePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const {contentEl} = this;
    contentEl.empty();
    contentEl.createEl('h2', {text: 'Choose a Practice Bank'});
    this.listEl = contentEl.createDiv({cls: 'practice-bank-list'});
    void this.renderBanks();
  }

  private async renderBanks() {
    const sources = bankSources(this.plugin.settings);
    const entries = await HistoryManager.loadAllPracticeEntries(
      this.app,
      sources,
    );
    this.listEl.empty();

    const counts = new Map<string, number>();
    for (const entry of entries) {
      counts.set(entry.bank, (counts.get(entry.bank) ?? 0) + 1);
    }

    // Configured banks first (in settings order, Hanzi leading), then any
    // extra bank names that only exist as legacy line tags.
    const banks: string[] = [];
    for (const source of sources) {
      if (!banks.includes(source.name)) banks.push(source.name);
    }
    for (const bank of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
      if (!banks.includes(bank)) banks.push(bank);
    }

    for (const bank of banks) {
      const count = counts.get(bank) ?? 0;
      const btn = this.listEl.createEl('button', {
        cls: 'practice-bank-option',
      });
      btn.type = 'button';
      btn.style.display = 'block';
      btn.style.width = '100%';
      btn.style.textAlign = 'left';
      btn.style.margin = '4px 0';
      btn.style.padding = '8px 12px';

      const nameEl = btn.createEl('span', {
        cls: 'practice-bank-name',
        text: bank,
      });
      nameEl.style.fontWeight = 'bold';
      nameEl.style.marginRight = '8px';
      btn.createEl('span', {
        cls: 'practice-bank-count',
        text: `${count} card${count === 1 ? '' : 's'}`,
      });

      btn.addEventListener('click', () => {
        this.close();
        void this.plugin.activateView(bank);
      });
    }
  }

  onClose() {
    const {contentEl} = this;
    contentEl.empty();
  }
}
