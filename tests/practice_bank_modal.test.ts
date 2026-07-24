import {App} from 'obsidian';
import {PracticeBankModal} from '../src/commands/practice_bank_modal';
import {HistoryManager} from '../src/utils/history_manager';
import {CardType, PracticeEntry} from '../src/utils/practice_list';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('PracticeBankModal', () => {
  const entries: PracticeEntry[] = [
    {
      id: 'aaaaaaaa',
      cardType: CardType.HANZI,
      bank: 'Hanzi',
      character: '好',
      pinyin: 'hao3',
      english: 'good',
    },
    {
      id: 'bbbbbbbb',
      cardType: CardType.FLASHCARD,
      bank: 'Capitals',
      front: 'France',
      back: 'Paris',
    },
    // A bank that exists only as a legacy line tag (not configured).
    {
      id: 'cccccccc',
      cardType: CardType.FLASHCARD,
      bank: 'Legacy',
      front: 'x',
      back: 'y',
    },
  ];

  let modal: PracticeBankModal;
  let activateView: jest.Mock;

  beforeEach(async () => {
    jest
      .spyOn(HistoryManager, 'loadAllPracticeEntries')
      .mockResolvedValue(entries);
    activateView = jest.fn();
    const plugin = {
      settings: {
        historyFilePath: 'history.md',
        practiceFilePath: 'words.md',
        banks: [
          {name: 'Capitals', filePath: 'capitals.md'},
          {name: 'German', filePath: 'german.md'},
        ],
        version: 1,
      },
      activateView,
    } as never;
    modal = new PracticeBankModal(new App(), plugin);
    modal.open();
    await flush();
  });

  it('lists configured banks first (Hanzi leading) then legacy tags, with counts', () => {
    const names = Array.from(
      modal.contentEl.querySelectorAll('.practice-bank-name'),
    ).map(el => el.textContent);
    expect(names).toEqual(['Hanzi', 'Capitals', 'German', 'Legacy']);
    const counts = Array.from(
      modal.contentEl.querySelectorAll('.practice-bank-count'),
    ).map(el => el.textContent);
    // German is configured but empty; singular/plural handled.
    expect(counts).toEqual(['1 card', '1 card', '0 cards', '1 card']);
  });

  it('clicking a bank closes the modal and opens the practice view on it', () => {
    const options = modal.contentEl.querySelectorAll('.practice-bank-option');
    (options[1] as HTMLElement).dispatchEvent(new MouseEvent('click'));
    expect(activateView).toHaveBeenCalledWith('Capitals');
    // close() ran onClose, which empties the modal.
    expect(modal.contentEl.childElementCount).toBe(0);
  });
});
