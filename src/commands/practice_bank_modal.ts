import {App, Modal} from 'obsidian';
import HanziPracticePlugin from '../main';
import {resolveBankSources} from '../settings';
import {HistoryManager} from '../utils/history_manager';

/**
 * The `practice` command's modal: lists every bank (the Hanzi bank plus each
 * bank configured in settings — even ones with no cards yet — plus any
 * legacy bank tags found in the files) with its card count. Clicking a bank
 * practices it alone (the quick path); each bank also has a CHECKBOX so
 * several can be selected and practiced together via the "Practice selected"
 * button. Banks contributed by a data pack are NESTED under the pack's name
 * with a group checkbox that selects the whole pack in one click.
 */
export class PracticeBankModal extends Modal {
  private plugin: HanziPracticePlugin;
  private listEl!: HTMLElement;
  private selectedBtn!: HTMLButtonElement;
  /** Checked banks, in no particular order (render order applies on start). */
  private selected = new Set<string>();
  /** Every listed bank in render order — the order multi-practice uses. */
  private orderedBanks: string[] = [];

  constructor(app: App, plugin: HanziPracticePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const {contentEl} = this;
    contentEl.empty();
    contentEl.createEl('h2', {text: 'Choose a Practice Bank'});
    this.listEl = contentEl.createDiv({cls: 'practice-bank-list'});

    // The multi-select action: disabled until at least one bank is checked.
    const footer = contentEl.createDiv({cls: 'practice-selected-footer'});
    footer.style.marginTop = '12px';
    this.selectedBtn = footer.createEl('button', {
      cls: 'practice-selected',
      text: 'Practice selected (0)',
    });
    this.selectedBtn.type = 'button';
    this.selectedBtn.disabled = true;
    this.selectedBtn.style.width = '100%';
    this.selectedBtn.style.padding = '8px 12px';
    this.selectedBtn.addEventListener('click', () => {
      if (this.selected.size === 0) return;
      const banks = this.orderedBanks.filter(b => this.selected.has(b));
      this.close();
      void this.plugin.activateView(banks);
    });

    void this.renderBanks();
  }

  private updateSelectedButton() {
    this.selectedBtn.textContent = `Practice selected (${this.selected.size})`;
    this.selectedBtn.disabled = this.selected.size === 0;
  }

  /**
   * One bank row: a checkbox (multi-select) + the bank button (click =
   * practice just this bank, the historical quick path).
   */
  private renderBankRow(
    parent: HTMLElement,
    bank: string,
    count: number,
    onToggle: (bank: string, checked: boolean) => void,
  ): HTMLInputElement {
    const row = parent.createDiv({cls: 'practice-bank-row'});
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '8px';
    row.style.margin = '4px 0';

    const check = row.createEl('input', {cls: 'practice-bank-check'});
    check.type = 'checkbox';
    check.dataset.bank = bank;
    check.addEventListener('change', () => {
      if (check.checked) this.selected.add(bank);
      else this.selected.delete(bank);
      onToggle(bank, check.checked);
      this.updateSelectedButton();
    });

    const btn = row.createEl('button', {cls: 'practice-bank-option'});
    btn.type = 'button';
    btn.style.display = 'block';
    btn.style.flex = '1';
    btn.style.textAlign = 'left';
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

    this.orderedBanks.push(bank);
    return check;
  }

  private async renderBanks() {
    const {sources, packGroups} = await resolveBankSources(
      this.app,
      this.plugin.settings,
    );
    const entries = await HistoryManager.loadAllPracticeEntries(
      this.app,
      sources,
    );
    this.listEl.empty();
    this.orderedBanks = [];
    this.selected.clear();
    this.updateSelectedButton();

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

    // Pack-contributed banks render nested under their pack, not top-level.
    const packOwned = new Set(packGroups.flatMap(g => g.bankNames));
    const noop = () => {};
    for (const bank of banks.filter(b => !packOwned.has(b))) {
      this.renderBankRow(this.listEl, bank, counts.get(bank) ?? 0, noop);
    }

    for (const group of packGroups) {
      const groupEl = this.listEl.createDiv({cls: 'practice-pack-group'});
      groupEl.style.margin = '8px 0';
      groupEl.style.paddingLeft = '10px';
      groupEl.style.borderLeft = '2px solid var(--background-modifier-border)';

      const header = groupEl.createDiv({cls: 'practice-pack-header'});
      header.style.display = 'flex';
      header.style.alignItems = 'center';
      header.style.gap = '8px';
      header.style.margin = '4px 0';

      const groupCheck = header.createEl('input', {
        cls: 'practice-pack-check',
      });
      groupCheck.type = 'checkbox';
      const nameEl = header.createEl('span', {
        cls: 'practice-pack-name',
        text: group.name,
      });
      nameEl.style.fontWeight = 'bold';

      // The group checkbox mirrors its banks: toggling it (un)checks them
      // all; it shows checked exactly when every bank in the pack is.
      const bankChecks: HTMLInputElement[] = [];
      for (const bank of group.bankNames) {
        bankChecks.push(
          this.renderBankRow(groupEl, bank, counts.get(bank) ?? 0, () => {
            groupCheck.checked = bankChecks.every(c => c.checked);
          }),
        );
      }
      groupCheck.addEventListener('change', () => {
        for (const check of bankChecks) {
          check.checked = groupCheck.checked;
          const bank = check.dataset.bank as string;
          if (groupCheck.checked) this.selected.add(bank);
          else this.selected.delete(bank);
        }
        this.updateSelectedButton();
      });
    }
  }

  onClose() {
    const {contentEl} = this;
    contentEl.empty();
  }
}
