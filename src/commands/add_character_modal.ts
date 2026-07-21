import {App, ButtonComponent, Modal, Notice, Setting, TFile} from 'obsidian';
import HanziPracticePlugin from '../main';
import {HanziPluginSettings} from '../settings';
import {CedictEntry} from '../dictionary/cedict_parser';
import {lookupDefinitions} from '../dictionary/definition_lookup';
import {prettifyPinyin} from '../utils/prettify_pinyin';
import {formatPracticeEntry, parsePracticeList} from '../utils/practice_list';

export class AddCharacterModal extends Modal {
  private character = '';
  /** The dictionary sense the user picked; Add stays disabled until set. */
  private selectedEntry: CedictEntry | null = null;
  private plugin: HanziPracticePlugin;
  private settings: HanziPluginSettings;
  private errorEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private optionsEl!: HTMLElement;
  private addButton!: ButtonComponent;
  /** Monotonic lookup counter so a slow lookup can't clobber a newer one. */
  private lookupSeq = 0;

  constructor(app: App, plugin: HanziPracticePlugin) {
    super(app);
    this.plugin = plugin;
    this.settings = plugin.settings;
  }

  onOpen() {
    const {contentEl} = this;
    contentEl.empty();
    contentEl.createEl('h2', {text: 'Add New Hanzi Character'});

    new Setting(contentEl)
      .setName('Character')
      .setDesc('Enter a single Chinese character to practice')
      .addText(text =>
        text.setPlaceholder('e.g. 汉').onChange(value => {
          this.character = value;
          this.clearError();
          void this.refreshDefinitionOptions(value.trim());
        }),
      );

    // Lookup status line ("Looking up…" / "Select a definition:" / not found)
    this.statusEl = contentEl.createEl('p', {cls: 'hanzi-add-status'});
    this.statusEl.style.color = 'var(--text-muted)';

    // The clickable list of dictionary senses for the typed character.
    this.optionsEl = contentEl.createDiv({cls: 'hanzi-def-options'});
    this.optionsEl.style.maxHeight = '240px';
    this.optionsEl.style.overflowY = 'auto';

    // Inline error message (hidden until a validation error occurs)
    this.errorEl = contentEl.createEl('p', {cls: 'hanzi-add-error'});
    this.errorEl.style.color = 'var(--text-error)';
    this.errorEl.style.display = 'none';

    new Setting(contentEl).addButton(btn => {
      this.addButton = btn;
      btn
        .setButtonText('Add')
        .setCta()
        .onClick(() => {
          const char = this.character.trim();
          if (char.length > 0 && this.selectedEntry) {
            void this.addCharacter(char, this.selectedEntry);
          }
        });
      this.setAddEnabled(false);
    });
  }

  /** Grey out / re-enable the Add button. */
  private setAddEnabled(enabled: boolean) {
    this.addButton.setDisabled(!enabled);
    this.addButton.buttonEl.disabled = !enabled;
    this.addButton.buttonEl.style.opacity = enabled ? '' : '0.4';
    this.addButton.buttonEl.style.cursor = enabled ? '' : 'not-allowed';
  }

  /**
   * Re-query the dictionary for the current input and rebuild the option
   * list. Any change to the input invalidates the previous selection, so the
   * Add button always reflects a sense of the character currently typed.
   */
  private async refreshDefinitionOptions(term: string) {
    const seq = ++this.lookupSeq;
    this.selectedEntry = null;
    this.setAddEnabled(false);
    this.optionsEl.empty();
    if (term.length === 0) {
      this.statusEl.setText('');
      return;
    }

    // The first lookup lazily parses the ~10MB CEDICT, which takes a moment.
    this.statusEl.setText('Looking up definitions…');
    const dictRes = await this.plugin.getDictionary();
    if (seq !== this.lookupSeq) return; // input changed while loading — stale
    if (!dictRes.ok) {
      this.statusEl.setText('');
      this.showError(
        `The dictionary could not be loaded: ${dictRes.val.message}`,
      );
      return;
    }

    const entries = lookupDefinitions(dictRes.val, term);
    if (entries.length === 0) {
      this.statusEl.setText(`No dictionary entries found for "${term}".`);
      return;
    }

    this.statusEl.setText('Select a definition:');
    for (const entry of entries) {
      const opt = this.optionsEl.createEl('button', {cls: 'hanzi-def-option'});
      opt.type = 'button';
      opt.style.display = 'block';
      opt.style.width = '100%';
      opt.style.textAlign = 'left';
      opt.style.margin = '4px 0';
      opt.style.padding = '6px 10px';
      opt.style.whiteSpace = 'normal';
      opt.style.height = 'auto';

      const pinyinEl = opt.createEl('span', {
        cls: 'hanzi-def-pinyin',
        text: prettifyPinyin(entry.pinyin),
      });
      pinyinEl.style.fontWeight = 'bold';
      pinyinEl.style.marginRight = '8px';
      opt.createEl('span', {cls: 'hanzi-def-english', text: entry.english});

      opt.addEventListener('click', () => this.selectEntry(entry, opt));
    }
  }

  /** Mark one option as chosen and unlock the Add button. */
  private selectEntry(entry: CedictEntry, optEl: HTMLElement) {
    for (const el of Array.from(
      this.optionsEl.querySelectorAll<HTMLElement>('.hanzi-def-option'),
    )) {
      el.removeClass('is-selected');
      el.style.borderColor = '';
      el.style.backgroundColor = '';
    }
    optEl.addClass('is-selected');
    optEl.style.borderColor = 'var(--interactive-accent)';
    optEl.style.backgroundColor = 'var(--background-modifier-hover)';
    this.selectedEntry = entry;
    this.clearError();
    this.setAddEnabled(true);
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

  async addCharacter(char: string, entry: CedictEntry) {
    const filePath = this.settings.practiceFilePath;
    const file = this.app.vault.getAbstractFileByPath(filePath);

    let text = '';
    if (file instanceof TFile) {
      text = await this.app.vault.read(file);
    }

    // Check if character already exists (compare the character field only).
    const existing = parsePracticeList(text);
    if (existing.some(e => e.character === char)) {
      this.showError(`"${char}" is already in your practice list.`);
      return; // keep the modal open so the user can correct the input
    }

    // Cache the SELECTED sense's pinyin + English onto the practice line so
    // the practice view never needs the dictionary.
    const newLine = formatPracticeEntry({
      character: char,
      pinyin: entry.pinyin,
      english: entry.english,
    });
    const newText =
      text.trim().length > 0
        ? `${text.replace(/\n$/, '')}\n${newLine}`
        : newLine;

    if (file instanceof TFile) {
      await this.app.vault.modify(file, newText);
    } else {
      await this.app.vault.create(filePath, newText);
    }

    this.close();
  }

  onClose() {
    const {contentEl} = this;
    contentEl.empty();
  }
}
