import {App, TFile} from 'obsidian';
// Mock-only export — same module instance as 'obsidian' under jest's mapper.
import {noticeMessages} from './__mocks__/obsidian';
import {AddFlashcardModal} from '../src/commands/add_flashcard_modal';
import {
  computeClozeId,
  computeFlashcardId,
  computeMultiChoiceId,
} from '../src/utils/practice_list';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('AddFlashcardModal', () => {
  let app: App;
  let modal: AddFlashcardModal;

  const makeModal = (banks: {name: string; filePath: string}[]) => {
    app = new App();
    const plugin = {settings: {banks}} as never;
    modal = new AddFlashcardModal(app, plugin);
    modal.open();
    return modal;
  };

  const setInput = (index: number, value: string) => {
    const areas = modal.contentEl.querySelectorAll('textarea');
    const el = areas[index];
    el.value = value;
    el.dispatchEvent(new Event('input', {bubbles: true}));
  };

  const selectType = (cardType: number) => {
    const select = modal.contentEl.querySelector(
      '.flash-type-dropdown',
    ) as HTMLSelectElement;
    select.value = String(cardType);
    select.dispatchEvent(new Event('change'));
  };

  const clickAdd = async () => {
    (modal.contentEl.querySelector('.mod-cta') as HTMLElement).dispatchEvent(
      new MouseEvent('click'),
    );
    await flush();
  };

  const errorText = () =>
    (modal.contentEl.querySelector('.flash-add-error') as HTMLElement)
      .textContent;

  beforeEach(() => {
    noticeMessages.length = 0;
  });

  it('shows a pointer to Settings when no banks are configured', () => {
    makeModal([]);
    expect(modal.contentEl.querySelector('.flash-no-banks')).not.toBeNull();
    expect(modal.contentEl.querySelector('.mod-cta')).toBeNull();
  });

  it('adds a flashcard line to a fresh bank file', async () => {
    makeModal([{name: 'Capitals', filePath: 'capitals.md'}]);
    setInput(0, 'France');
    setInput(1, 'Paris');
    await clickAdd();

    const id = computeFlashcardId('Capitals', 'France', 'Paris');
    expect(app.vault.create).toHaveBeenCalledWith(
      'capitals.md',
      `France\tParis\t\t${id}\t1\tCapitals`,
    );
    // Modal stays open for batch entry with the fields cleared.
    const areas = modal.contentEl.querySelectorAll('textarea');
    expect(areas[0].value).toBe('');
    expect(areas[1].value).toBe('');
  });

  it('writes card type 2 when the reversible toggle is on', async () => {
    makeModal([{name: 'German', filePath: 'german.md'}]);
    setInput(0, 'dog');
    setInput(1, 'Hund');
    (
      modal.contentEl.querySelector('.flash-reversible-toggle') as HTMLElement
    ).dispatchEvent(new MouseEvent('click'));
    await clickAdd();
    const id = computeFlashcardId('German', 'dog', 'Hund');
    expect(app.vault.create).toHaveBeenCalledWith(
      'german.md',
      `dog\tHund\t\t${id}\t2\tGerman`,
    );
  });

  it('appends to an existing bank file', async () => {
    makeModal([{name: 'Capitals', filePath: 'capitals.md'}]);
    const file = new TFile();
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(file);
    (app.vault.read as jest.Mock).mockResolvedValue(
      'existing\tline\t\tx\t1\tCapitals\n',
    );
    setInput(0, 'Spain');
    setInput(1, 'Madrid');
    await clickAdd();
    expect(app.vault.modify).toHaveBeenCalledWith(
      file,
      expect.stringContaining('existing\tline'),
    );
    const written = (app.vault.modify as jest.Mock).mock.calls[0][1] as string;
    expect(written.split('\n')).toHaveLength(2);
  });

  it('rejects a duplicate card and keeps the modal state', async () => {
    makeModal([{name: 'Capitals', filePath: 'capitals.md'}]);
    const id = computeFlashcardId('Capitals', 'France', 'Paris');
    const file = new TFile();
    (app.vault.getAbstractFileByPath as jest.Mock).mockReturnValue(file);
    (app.vault.read as jest.Mock).mockResolvedValue(
      `France\tParis\t\t${id}\t1\tCapitals`,
    );
    setInput(0, 'France');
    setInput(1, 'Paris');
    await clickAdd();
    expect(app.vault.modify).not.toHaveBeenCalled();
    expect(errorText()).toContain('already in the "Capitals" bank');
  });

  it('requires both front and back', async () => {
    makeModal([{name: 'Capitals', filePath: 'capitals.md'}]);
    setInput(0, 'France');
    await clickAdd();
    expect(errorText()).toBe('Front and back are both required.');
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it('adds a multiple-choice card with |-joined distractors', async () => {
    makeModal([{name: 'Grammar', filePath: 'grammar.md'}]);
    selectType(3);
    setInput(0, '你__狗吗？');
    setInput(1, '有没有');
    setInput(2, '不有\n没不有');
    await clickAdd();
    const id = computeMultiChoiceId('Grammar', '你__狗吗？', '有没有');
    expect(app.vault.create).toHaveBeenCalledWith(
      'grammar.md',
      `你__狗吗？\t有没有\t不有|没不有\t${id}\t3\tGrammar`,
    );
  });

  it('validates multiple-choice fields', async () => {
    makeModal([{name: 'Grammar', filePath: 'grammar.md'}]);
    selectType(3);
    await clickAdd();
    expect(errorText()).toBe('Question and answer are both required.');

    setInput(0, 'Q');
    setInput(1, 'A');
    await clickAdd();
    expect(errorText()).toBe('At least one wrong option is required.');

    setInput(2, 'A\nB');
    await clickAdd();
    expect(errorText()).toBe('A wrong option duplicates the answer.');
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it('adds a cloze card and requires a {{blank}}', async () => {
    makeModal([{name: 'Cloze', filePath: 'cloze.md'}]);
    selectType(4);
    await clickAdd();
    expect(errorText()).toBe('The sentence is required.');

    setInput(0, '我一个星期没吃饭。');
    await clickAdd();
    expect(errorText()).toContain('double braces');
    expect(app.vault.create).not.toHaveBeenCalled();

    setInput(0, '我一个星期{{没}}吃饭。');
    setInput(1, "I haven't eaten for a week.");
    await clickAdd();
    const id = computeClozeId('Cloze', '我一个星期{{没}}吃饭。');
    expect(app.vault.create).toHaveBeenCalledWith(
      'cloze.md',
      `我一个星期{{没}}吃饭。\tI haven't eaten for a week.\t\t${id}\t4\tCloze`,
    );
  });

  it('switching the card type swaps the field set', () => {
    makeModal([{name: 'Grammar', filePath: 'grammar.md'}]);
    expect(modal.contentEl.querySelectorAll('textarea')).toHaveLength(2);
    expect(
      modal.contentEl.querySelector('.flash-reversible-toggle'),
    ).not.toBeNull();
    selectType(3);
    expect(modal.contentEl.querySelectorAll('textarea')).toHaveLength(3);
    expect(
      modal.contentEl.querySelector('.flash-reversible-toggle'),
    ).toBeNull();
    selectType(4);
    expect(modal.contentEl.querySelectorAll('textarea')).toHaveLength(2);
  });

  it('picks the bank from the dropdown', async () => {
    makeModal([
      {name: 'A', filePath: 'a.md'},
      {name: 'B', filePath: 'b.md'},
    ]);
    const bankSelect = modal.contentEl.querySelector(
      '.flash-bank-dropdown',
    ) as HTMLSelectElement;
    bankSelect.value = '1';
    bankSelect.dispatchEvent(new Event('change'));
    setInput(0, 'front');
    setInput(1, 'back');
    await clickAdd();
    expect(app.vault.create).toHaveBeenCalledWith(
      'b.md',
      expect.stringContaining('\tB'),
    );
  });

  it('clears the content on close', () => {
    makeModal([{name: 'A', filePath: 'a.md'}]);
    modal.close();
    expect(modal.contentEl.childElementCount).toBe(0);
  });
});
