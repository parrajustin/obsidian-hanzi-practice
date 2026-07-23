import {App, ButtonComponent, Modal, Notice, Setting, TFile} from 'obsidian';
import HanziPracticePlugin from '../main';
import {BankConfig, HanziPluginSettings} from '../settings';
import {
  CardType,
  computeFlashcardId,
  formatPracticeEntry,
  FlashcardEntry,
  parsePracticeList,
  sanitizeField,
} from '../utils/practice_list';

/**
 * Modal to add a flashcard to a practice bank. Banks are defined in settings
 * (each with its own storage file — like the Hanzi bank's words file), so the
 * bank is picked from a dropdown; front/back are the two sides of the card;
 * the reversible toggle decides whether practice may prompt with either side.
 * The modal stays open after a successful add so a batch of cards can be
 * entered in one sitting (front/back clear, bank + reversible stick).
 */
export class AddFlashcardModal extends Modal {
  private bank: BankConfig | null = null;
  private front = '';
  private back = '';
  private reversible = false;
  private plugin: HanziPracticePlugin;
  private settings: HanziPluginSettings;
  private errorEl!: HTMLElement;
  private addButton!: ButtonComponent;
  private frontInput!: HTMLTextAreaElement;
  private backInput!: HTMLTextAreaElement;

  constructor(app: App, plugin: HanziPracticePlugin) {
    super(app);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  onOpen() {
    const {contentEl} = this;
    contentEl.empty();
    contentEl.createEl('h2', {text: 'Add Flash Card'});

    const banks = this.settings.banks;
    if (banks.length === 0) {
      contentEl.createEl('p', {
        cls: 'flash-no-banks',
        text: 'No practice banks configured yet. Add one in Settings → Practice Banks (the + button), then come back.',
      });
      return;
    }
    this.bank = banks[0];

    new Setting(contentEl)
      .setName('Bank')
      .setDesc('Which practice bank this card belongs to.')
      .addDropdown(dropdown => {
        dropdown.selectEl.addClass('flash-bank-dropdown');
        banks.forEach((bank, i) => dropdown.addOption(String(i), bank.name));
        dropdown.setValue('0').onChange(value => {
          this.bank = banks[parseInt(value, 10)] ?? banks[0];
          this.clearError();
        });
      });

    new Setting(contentEl)
      .setName('Front')
      .setDesc('The prompt side of the card.')
      .addTextArea(text => {
        this.frontInput = text.inputEl;
        text.setPlaceholder('e.g. Capital of France?').onChange(value => {
          this.front = value;
          this.clearError();
        });
      });

    new Setting(contentEl)
      .setName('Back')
      .setDesc('The answer side of the card.')
      .addTextArea(text => {
        this.backInput = text.inputEl;
        text.setPlaceholder('e.g. Paris').onChange(value => {
          this.back = value;
          this.clearError();
        });
      });

    new Setting(contentEl)
      .setName('Reversible')
      .setDesc('When practicing, either side may be shown as the prompt.')
      .addToggle(toggle => {
        toggle.toggleEl.addClass('flash-reversible-toggle');
        toggle.setValue(this.reversible).onChange(value => {
          this.reversible = value;
        });
      });

    // Inline error message (hidden until a validation error occurs)
    this.errorEl = contentEl.createEl('p', {cls: 'flash-add-error'});
    this.errorEl.style.color = 'var(--text-error)';
    this.errorEl.style.display = 'none';

    new Setting(contentEl).addButton(btn => {
      this.addButton = btn;
      btn
        .setButtonText('Add')
        .setCta()
        .onClick(() => {
          void this.addFlashcard();
        });
    });
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

  async addFlashcard() {
    const bank = this.bank;
    const front = sanitizeField(this.front);
    const back = sanitizeField(this.back);
    if (!bank || !front || !back) {
      this.showError('Front and back are both required.');
      return;
    }

    // The card is stored in ITS BANK's file (each bank has its own, set in
    // settings) — the same enrich-on-write pattern as the hanzi words file.
    const filePath = bank.filePath;
    const file = this.app.vault.getAbstractFileByPath(filePath);

    let text = '';
    if (file instanceof TFile) {
      text = await this.app.vault.read(file);
    }

    // The id hashes bank+front+back, so the same card text may live in two
    // different banks — but not twice in the same one.
    const id = computeFlashcardId(bank.name, front, back);
    const existing = parsePracticeList(text);
    if (existing.some(e => e.id === id)) {
      this.showError(`This card is already in the "${bank.name}" bank.`);
      return; // keep the modal open so the user can correct the input
    }

    const entry: FlashcardEntry = {
      id,
      cardType: this.reversible
        ? CardType.REVERSIBLE_FLASHCARD
        : CardType.FLASHCARD,
      bank: bank.name,
      front,
      back,
    };
    const newLine = formatPracticeEntry(entry);
    const newText =
      text.trim().length > 0
        ? `${text.replace(/\n$/, '')}\n${newLine}`
        : newLine;

    if (file instanceof TFile) {
      await this.app.vault.modify(file, newText);
    } else {
      await this.app.vault.create(filePath, newText);
    }

    new Notice(`Added card to "${bank.name}".`);
    // Stay open for the next card of the same bank.
    this.front = '';
    this.back = '';
    this.frontInput.value = '';
    this.backInput.value = '';
    this.frontInput.focus();
  }

  onClose() {
    const {contentEl} = this;
    contentEl.empty();
  }
}
