import {App, TFile} from 'obsidian';
// Mock-only export — same module instance as 'obsidian' under jest's mapper.
import {noticeMessages} from './__mocks__/obsidian';
import {EditBankModal} from '../src/commands/edit_bank_modal';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const HANZI_LINE = '好\thao3\tgood\taaaaaaaa\t0\tHanzi';
const FLASH_LINE = 'France\tParis\t\tbbbbbbbb\t1\tCapitals';
const MC_LINE = '你__狗吗？\t有没有\t不有|没不有\tcccccccc\t3\tCapitals';
const CLOZE_LINE = '四{{个}}月\tfour months\t\tdddddddd\t4\tCapitals';

describe('EditBankModal', () => {
  let app: App;
  let modal: EditBankModal;
  let files: Record<string, string>;

  const openModal = async () => {
    app = new App();
    // Vault backed by an in-memory map; only known paths resolve to a TFile.
    (app.vault.getAbstractFileByPath as jest.Mock).mockImplementation(
      (path: string) => (path in files ? new TFile() : null),
    );
    (app.vault.read as jest.Mock).mockImplementation(() =>
      // The modal reads one source at a time in bankSources order; return
      // based on the path of the LAST getAbstractFileByPath call.
      Promise.resolve(files[lastPath()] ?? ''),
    );
    const lastPath = () =>
      (app.vault.getAbstractFileByPath as jest.Mock).mock.calls.at(-1)![0];
    const plugin = {
      settings: {
        historyFilePath: 'history.md',
        practiceFilePath: 'words.md',
        banks: [{name: 'Capitals', filePath: 'capitals.md'}],
        version: 1,
      },
    } as never;
    modal = new EditBankModal(app, plugin);
    modal.open();
    await flush();
  };

  beforeEach(() => {
    noticeMessages.length = 0;
    files = {
      'words.md': HANZI_LINE,
      'capitals.md': [FLASH_LINE, MC_LINE, CLOZE_LINE].join('\n'),
    };
  });

  it('lists every card type with its own row layout, grouped by bank', async () => {
    await openModal();
    const rows = modal.contentEl.querySelectorAll('.hanzi-bank-row');
    expect(rows).toHaveLength(4);
    // Two banks → headings render.
    const headings = Array.from(
      modal.contentEl.querySelectorAll('.practice-bank-heading'),
    ).map(h => h.textContent);
    expect(headings).toEqual(['Hanzi', 'Capitals']);

    expect(modal.contentEl.querySelector('.hanzi-bank-char')?.textContent).toBe(
      '好',
    );
    expect(
      modal.contentEl.querySelector('.hanzi-bank-pinyin')?.textContent,
    ).toBe('hǎo');
    expect(
      modal.contentEl.querySelector('.flash-bank-front')?.textContent,
    ).toBe('France');
    expect(
      modal.contentEl.querySelector('.mc-bank-question')?.textContent,
    ).toBe('你__狗吗？');
    const mcAnswer = modal.contentEl.querySelector(
      '.mc-bank-answer',
    ) as HTMLElement;
    expect(mcAnswer.textContent).toBe('有没有');
    expect(mcAnswer.title).toContain('不有, 没不有');
    expect(modal.contentEl.querySelector('.cloze-bank-text')?.textContent).toBe(
      '四{{个}}月',
    );
    expect(modal.contentEl.querySelector('.cloze-bank-hint')?.textContent).toBe(
      'four months',
    );
  });

  it('shows the empty message when no bank has cards', async () => {
    files = {};
    await openModal();
    expect(modal.contentEl.querySelector('.hanzi-bank-empty')).not.toBeNull();
  });

  it('removing a card rewrites only its own bank file', async () => {
    await openModal();
    // Row order: hanzi, flashcard, mc, cloze — remove the MC card.
    const removeButtons =
      modal.contentEl.querySelectorAll('.hanzi-bank-remove');
    // Keep the in-memory read stable while removeEntry re-reads capitals.md.
    (removeButtons[2] as HTMLElement).dispatchEvent(new MouseEvent('click'));
    await flush();

    expect(app.vault.modify).toHaveBeenCalledTimes(1);
    const written = (app.vault.modify as jest.Mock).mock.calls[0][1] as string;
    expect(written).toContain('France');
    expect(written).toContain('四{{个}}月');
    expect(written).not.toContain('有没有');
    expect(noticeMessages.some(m => m.includes('Removed'))).toBe(true);
  });
});
