import {App, ButtonComponent, Modal, Notice, Setting, TFile} from 'obsidian';
import HanziPracticePlugin from '../main';
import {BankConfig, HanziPluginSettings} from '../settings';
import {
  CardType,
  computeClozeId,
  computeFlashcardId,
  computeMultiChoiceId,
  formatPracticeEntry,
  parseClozeSegments,
  parsePracticeList,
  PracticeEntry,
  sanitizeField,
  sanitizeOption,
} from '../utils/practice_list';

/**
 * Modal to add a card to a practice bank. Banks are defined in settings
 * (each with its own storage file — like the Hanzi bank's words file), so the
 * bank is picked from a dropdown. A card-type dropdown swaps the field set:
 *
 *   - Flashcard: front/back textareas + a reversible toggle (either side may
 *     be shown as the prompt → card type 2 instead of 1).
 *   - Multiple choice: question, correct answer, and wrong options (one per
 *     line).
 *   - Fill in the blank: a sentence with each answer wrapped in `{{…}}`,
 *     plus an optional hint; at least one `{{…}}` blank is required so a
 *     blankless card can't be authored by accident.
 *
 * The modal stays open after a successful add so a batch of cards can be
 * entered in one sitting (text fields clear; bank + type + toggle stick).
 */
export class AddFlashcardModal extends Modal {
  private bank: BankConfig | null = null;
  private cardType: CardType = CardType.FLASHCARD;
  private front = '';
  private back = '';
  private reversible = false;
  private question = '';
  private answer = '';
  private distractorsText = '';
  private clozeText = '';
  private clozeHint = '';
  private plugin: HanziPracticePlugin;
  private settings: HanziPluginSettings;
  private errorEl!: HTMLElement;
  private addButton!: ButtonComponent;
  private fieldsEl!: HTMLElement;
  private textInputs: HTMLTextAreaElement[] = [];

  constructor(app: App, plugin: HanziPracticePlugin) {
    super(app);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  onOpen() {
    const {contentEl} = this;
    contentEl.empty();
    contentEl.createEl('h2', {text: 'Add Card'});

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
      .setName('Card type')
      .setDesc('How this card is practiced.')
      .addDropdown(dropdown => {
        dropdown.selectEl.addClass('flash-type-dropdown');
        dropdown.addOption(String(CardType.FLASHCARD), 'Flashcard');
        dropdown.addOption(String(CardType.MULTIPLE_CHOICE), 'Multiple choice');
        dropdown.addOption(String(CardType.CLOZE), 'Fill in the blank');
        dropdown.setValue(String(CardType.FLASHCARD)).onChange(value => {
          this.cardType = parseInt(value, 10) as CardType;
          this.clearError();
          this.renderFields();
        });
      });

    this.fieldsEl = contentEl.createDiv({cls: 'flash-card-fields'});
    this.renderFields();

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
          void this.addCard();
        });
    });
  }

  /** (Re)build the per-card-type input fields. */
  private renderFields() {
    this.fieldsEl.empty();
    this.textInputs = [];

    const addTextArea = (
      name: string,
      desc: string,
      placeholder: string,
      onChange: (value: string) => void,
    ) => {
      new Setting(this.fieldsEl)
        .setName(name)
        .setDesc(desc)
        .addTextArea(text => {
          this.textInputs.push(text.inputEl);
          text.setPlaceholder(placeholder).onChange(value => {
            onChange(value);
            this.clearError();
          });
        });
    };

    if (this.cardType === CardType.MULTIPLE_CHOICE) {
      addTextArea(
        'Question',
        'The prompt shown above the options.',
        'e.g. 你__狗吗？',
        v => (this.question = v),
      );
      addTextArea(
        'Answer',
        'The correct option.',
        'e.g. 有没有',
        v => (this.answer = v),
      );
      addTextArea(
        'Wrong options',
        'The distractors, one per line.',
        'e.g. 不有\n没不有',
        v => (this.distractorsText = v),
      );
      return;
    }

    if (this.cardType === CardType.CLOZE) {
      addTextArea(
        'Sentence',
        'Wrap each blanked-out answer in double braces.',
        'e.g. 我一个星期{{没}}吃饭。',
        v => (this.clozeText = v),
      );
      addTextArea(
        'Hint',
        'Optional hint or translation shown with the blanked sentence.',
        "e.g. I haven't eaten for a week.",
        v => (this.clozeHint = v),
      );
      return;
    }

    addTextArea(
      'Front',
      'The prompt side of the card.',
      'e.g. Capital of France?',
      v => (this.front = v),
    );
    addTextArea(
      'Back',
      'The answer side of the card.',
      'e.g. Paris',
      v => (this.back = v),
    );
    new Setting(this.fieldsEl)
      .setName('Reversible')
      .setDesc('When practicing, either side may be shown as the prompt.')
      .addToggle(toggle => {
        toggle.toggleEl.addClass('flash-reversible-toggle');
        toggle.setValue(this.reversible).onChange(value => {
          this.reversible = value;
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

  /** Validate the current field set into an entry, or null (error shown). */
  private buildEntry(bankName: string): PracticeEntry | null {
    if (this.cardType === CardType.MULTIPLE_CHOICE) {
      const question = sanitizeField(this.question);
      const answer = sanitizeOption(this.answer);
      const distractors = this.distractorsText
        .split('\n')
        .map(sanitizeOption)
        .filter(d => d.length > 0);
      if (!question || !answer) {
        this.showError('Question and answer are both required.');
        return null;
      }
      if (distractors.length === 0) {
        this.showError('At least one wrong option is required.');
        return null;
      }
      if (distractors.includes(answer)) {
        this.showError('A wrong option duplicates the answer.');
        return null;
      }
      return {
        id: computeMultiChoiceId(bankName, question, answer),
        cardType: CardType.MULTIPLE_CHOICE,
        bank: bankName,
        question,
        answer,
        distractors,
      };
    }

    if (this.cardType === CardType.CLOZE) {
      const text = sanitizeField(this.clozeText);
      const hint = sanitizeField(this.clozeHint);
      if (!text) {
        this.showError('The sentence is required.');
        return null;
      }
      if (!parseClozeSegments(text).some(s => s.blank)) {
        this.showError(
          'Wrap at least one answer in double braces, e.g. {{没}}.',
        );
        return null;
      }
      return {
        id: computeClozeId(bankName, text),
        cardType: CardType.CLOZE,
        bank: bankName,
        text,
        hint,
      };
    }

    const front = sanitizeField(this.front);
    const back = sanitizeField(this.back);
    if (!front || !back) {
      this.showError('Front and back are both required.');
      return null;
    }
    return {
      id: computeFlashcardId(bankName, front, back),
      cardType: this.reversible
        ? CardType.REVERSIBLE_FLASHCARD
        : CardType.FLASHCARD,
      bank: bankName,
      front,
      back,
    };
  }

  async addCard() {
    const bank = this.bank;
    if (!bank) return;
    const entry = this.buildEntry(bank.name);
    if (!entry) return; // validation error already shown

    // The card is stored in ITS BANK's file (each bank has its own, set in
    // settings) — the same enrich-on-write pattern as the hanzi words file.
    const filePath = bank.filePath;
    const file = this.app.vault.getAbstractFileByPath(filePath);

    let text = '';
    if (file instanceof TFile) {
      text = await this.app.vault.read(file);
    }

    // Ids hash the bank + the card's identifying text, so the same card may
    // live in two different banks — but not twice in the same one.
    const existing = parsePracticeList(text);
    if (existing.some(e => e.id === entry.id)) {
      this.showError(`This card is already in the "${bank.name}" bank.`);
      return; // keep the modal open so the user can correct the input
    }

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
    // Stay open for the next card of the same bank and type.
    this.front = '';
    this.back = '';
    this.question = '';
    this.answer = '';
    this.distractorsText = '';
    this.clozeText = '';
    this.clozeHint = '';
    for (const input of this.textInputs) {
      input.value = '';
    }
    this.textInputs[0]?.focus();
  }

  onClose() {
    const {contentEl} = this;
    contentEl.empty();
  }
}
