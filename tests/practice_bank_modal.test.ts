import {App} from 'obsidian';
import {FileUtil} from 'standard-obsidian-lib/src/filesystem/file_util';
import {Ok} from 'standard-ts-lib/src/result';
import {TextEncoder, TextDecoder} from 'util';
import {PracticeBankModal} from '../src/commands/practice_bank_modal';
import {HistoryManager} from '../src/utils/history_manager';
import {CardType, PracticeEntry} from '../src/utils/practice_list';

global.TextEncoder = TextEncoder;
global.TextDecoder = TextDecoder as any;

jest.mock('standard-obsidian-lib/src/filesystem/file_util');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const EURO_PACK = JSON.stringify({
  version: 1,
  name: 'Euro Pack',
  banks: [
    {name: 'French', filePath: 'french-cards.md'},
    {name: 'Spanish', filePath: 'spanish-cards.md'},
  ],
});

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
    // True/false cards count like any other card type.
    {
      id: 'ffffffff',
      cardType: CardType.TRUE_FALSE,
      bank: 'Capitals',
      statement: '你有没有一只狗吗？',
      isCorrect: false,
      explanation: '',
    },
    // Contributed by the Euro Pack's French bank file.
    {
      id: 'dddddddd',
      cardType: CardType.FLASHCARD,
      bank: 'French',
      front: 'bonjour',
      back: 'hello',
    },
  ];

  let modal: PracticeBankModal;
  let activateView: jest.Mock;

  const openModal = async (dataPacks: {filePath: string}[]) => {
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
        dataPacks,
        version: 2,
      },
      activateView,
    } as never;
    modal = new PracticeBankModal(new App(), plugin);
    modal.open();
    await flush();
  };

  const names = (root: ParentNode = modal.contentEl) =>
    Array.from(root.querySelectorAll('.practice-bank-name')).map(
      el => el.textContent,
    );

  const check = (bank: string, checked = true) => {
    const box = Array.from(
      modal.contentEl.querySelectorAll('.practice-bank-check'),
    ).find(el => (el as HTMLInputElement).dataset.bank === bank) as
      HTMLInputElement | undefined;
    if (!box) throw new Error(`no checkbox for bank ${bank}`);
    box.checked = checked;
    box.dispatchEvent(new Event('change'));
    return box;
  };

  const selectedBtn = () =>
    modal.contentEl.querySelector('.practice-selected') as HTMLButtonElement;

  beforeEach(() => {
    jest.restoreAllMocks();
    (FileUtil.fetchFile as jest.Mock).mockResolvedValue(
      Ok(new TextEncoder().encode(EURO_PACK)),
    );
  });

  it('lists configured banks first (Hanzi leading) then legacy tags, with counts', async () => {
    await openModal([]);
    expect(names()).toEqual([
      'Hanzi',
      'Capitals',
      'German',
      'French',
      'Legacy',
    ]);
    const counts = Array.from(
      modal.contentEl.querySelectorAll('.practice-bank-count'),
    ).map(el => el.textContent);
    // German is configured but empty; singular/plural handled. Capitals
    // holds a flashcard + a true/false card. French exists only as a line
    // tag here (no pack registered), so it lists like Legacy does.
    expect(counts).toEqual([
      '1 card',
      '2 cards',
      '0 cards',
      '1 card',
      '1 card',
    ]);
  });

  it('clicking a bank closes the modal and opens the practice view on it', async () => {
    await openModal([]);
    const options = modal.contentEl.querySelectorAll('.practice-bank-option');
    (options[1] as HTMLElement).dispatchEvent(new MouseEvent('click'));
    expect(activateView).toHaveBeenCalledWith('Capitals');
    // close() ran onClose, which empties the modal.
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('checking several banks enables Practice selected and opens their union', async () => {
    await openModal([]);
    expect(selectedBtn().disabled).toBe(true);
    expect(selectedBtn().textContent).toBe('Practice selected (0)');

    check('Capitals');
    check('German');
    expect(selectedBtn().disabled).toBe(false);
    expect(selectedBtn().textContent).toBe('Practice selected (2)');

    selectedBtn().dispatchEvent(new MouseEvent('click'));
    expect(activateView).toHaveBeenCalledWith(['Capitals', 'German']);
    expect(modal.contentEl.childElementCount).toBe(0);
  });

  it('unchecking a bank shrinks the selection back', async () => {
    await openModal([]);
    check('Capitals');
    check('German');
    check('German', false);
    expect(selectedBtn().textContent).toBe('Practice selected (1)');
    check('Capitals', false);
    expect(selectedBtn().disabled).toBe(true);
  });

  it("nests a registered pack's banks under its name", async () => {
    await openModal([{filePath: 'euro-pack.json'}]);
    const group = modal.contentEl.querySelector(
      '.practice-pack-group',
    ) as HTMLElement;
    expect(group).not.toBeNull();
    expect(group.querySelector('.practice-pack-name')?.textContent).toBe(
      'Euro Pack',
    );
    // The pack's banks render inside the group (French with its 1 card,
    // Spanish configured-but-empty)…
    expect(names(group)).toEqual(['French', 'Spanish']);
    // …and NOT at the top level, which keeps manual banks + legacy tags.
    expect(names()).toEqual([
      'Hanzi',
      'Capitals',
      'German',
      'Legacy',
      'French',
      'Spanish',
    ]);
  });

  it('the pack checkbox selects the whole pack for one practice run', async () => {
    await openModal([{filePath: 'euro-pack.json'}]);
    const packCheck = modal.contentEl.querySelector(
      '.practice-pack-check',
    ) as HTMLInputElement;
    packCheck.checked = true;
    packCheck.dispatchEvent(new Event('change'));

    const group = modal.contentEl.querySelector(
      '.practice-pack-group',
    ) as HTMLElement;
    group
      .querySelectorAll('.practice-bank-check')
      .forEach(box => expect((box as HTMLInputElement).checked).toBe(true));
    expect(selectedBtn().textContent).toBe('Practice selected (2)');

    selectedBtn().dispatchEvent(new MouseEvent('click'));
    expect(activateView).toHaveBeenCalledWith(['French', 'Spanish']);
  });

  it('unchecking the pack checkbox clears its banks; a lone uncheck unsyncs it', async () => {
    await openModal([{filePath: 'euro-pack.json'}]);
    const packCheck = modal.contentEl.querySelector(
      '.practice-pack-check',
    ) as HTMLInputElement;
    packCheck.checked = true;
    packCheck.dispatchEvent(new Event('change'));
    packCheck.checked = false;
    packCheck.dispatchEvent(new Event('change'));
    expect(selectedBtn().disabled).toBe(true);

    // Re-select the pack, then drop just French: the group box unchecks.
    packCheck.checked = true;
    packCheck.dispatchEvent(new Event('change'));
    check('French', false);
    expect(packCheck.checked).toBe(false);
    expect(selectedBtn().textContent).toBe('Practice selected (1)');

    // Re-checking French by hand syncs the group box back on.
    check('French');
    expect(packCheck.checked).toBe(true);
  });

  it('pack banks can be combined with top-level banks', async () => {
    await openModal([{filePath: 'euro-pack.json'}]);
    check('Capitals');
    check('Spanish');
    selectedBtn().dispatchEvent(new MouseEvent('click'));
    expect(activateView).toHaveBeenCalledWith(['Capitals', 'Spanish']);
  });

  it('every bank row shows its average score (unpracticed cards count 0)', async () => {
    // France was reviewed twice (both 4 → card average 4); every other card
    // has no history and scores 0. Capitals = (4 + 0) / 2 = 2.0.
    jest.spyOn(HistoryManager, 'parseHistory').mockResolvedValue({
      bbbbbbbb: [
        {timestamp: 1, difficulty: 4},
        {timestamp: 2, difficulty: 4},
      ],
    });
    await openModal([]);
    const scores = Array.from(
      modal.contentEl.querySelectorAll('.practice-bank-score'),
    ).map(el => el.textContent);
    // Hanzi, Capitals, German (configured, no cards), French tag, Legacy.
    expect(scores).toEqual([
      'avg 0.0',
      'avg 2.0',
      'avg 0.0',
      'avg 0.0',
      'avg 0.0',
    ]);
  });

  it('selecting banks shows the live average over their cards', async () => {
    jest.spyOn(HistoryManager, 'parseHistory').mockResolvedValue({
      bbbbbbbb: [
        {timestamp: 1, difficulty: 4},
        {timestamp: 2, difficulty: 4},
      ],
    });
    await openModal([]);
    const scoreEl = modal.contentEl.querySelector(
      '.practice-selected-score',
    ) as HTMLElement;
    expect(scoreEl.style.display).toBe('none');

    // Capitals (France avg 4 + unpracticed TF 0 → 2 cards) + empty German:
    // the average weighs CARDS, not banks → 4 / 2 = 2.0.
    check('Capitals');
    check('German');
    expect(scoreEl.style.display).toBe('');
    expect(scoreEl.textContent).toBe('Average score: 2.0');

    // Hanzi's 好 is unpracticed → dilutes the average: 4 / 3 ≈ 1.3.
    check('Hanzi');
    expect(scoreEl.textContent).toBe('Average score: 1.3');

    check('Capitals', false);
    check('German', false);
    check('Hanzi', false);
    expect(scoreEl.style.display).toBe('none');
  });
});
