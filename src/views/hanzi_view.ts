import {ItemView, Notice, ViewStateResult, WorkspaceLeaf} from 'obsidian';
import {HANZI_VIEW_TYPE} from '../main';

import HanziPracticePlugin from '../main';
import {bankSources} from '../settings';
import {HistoryManager} from '../utils/history_manager';
import {PinyinSelector} from '../components/pinyin_selector';
import {FlashCard} from '../components/flash_card';
import {HanziQuizWriter} from '../writer/quiz_writer';
import {
  CardType,
  computeEntryId,
  FlashcardEntry,
  HANZI_BANK,
  IsFlashcardEntry,
  PracticeEntry,
} from '../utils/practice_list';

/**
 * The practice view. One view instance practices one BANK (a named cluster of
 * cards — the bank is view state, set by `activateView`), rendering whatever
 * UI the due card's type needs: the stroke-drawing quiz for hanzi cards, a
 * flip-and-self-grade card for (reversible) flashcards.
 */
export class HanziPracticeView extends ItemView {
  private writer: HanziQuizWriter | null = null;
  /** The practice item being quizzed; history is keyed by its id. */
  private currentEntry: PracticeEntry | null = null;
  /** The bank this view is practicing. */
  private bank: string = HANZI_BANK;
  /** Whether onOpen has run (setState before that must not render). */
  private opened = false;
  private currentCharacter = '汉';
  private targetPinyin = '';
  private englishDef = '';
  private strokeMistakes = 0;
  private pinyinMistakes = 0;
  /** Once Give Up is pressed, the attempt can only ever score 0. */
  private gaveUp = false;
  private plugin: HanziPracticePlugin;

  constructor(leaf: WorkspaceLeaf, plugin: HanziPracticePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return HANZI_VIEW_TYPE;
  }

  getDisplayText() {
    return this.bank === HANZI_BANK
      ? 'Hanzi Practice'
      : `Practice: ${this.bank}`;
  }

  /** The bank travels as view state so reopening the tab keeps practicing it. */
  override async setState(
    state: unknown,
    result: ViewStateResult,
  ): Promise<void> {
    await super.setState(state, result);
    const bank = (state as {bank?: unknown} | null | undefined)?.bank;
    if (typeof bank === 'string' && bank.length > 0 && bank !== this.bank) {
      this.bank = bank;
      if (this.opened) await this.loadNext();
    }
  }

  override getState(): Record<string, unknown> {
    return {bank: this.bank};
  }

  async onOpen() {
    this.opened = true;
    await this.loadNext();
  }

  /**
   * Pick the next due card of this view's bank and render it. For hanzi
   * cards the pinyin + definition are read straight from the practice list
   * (they were cached there when the character was added) — the heavy CEDICT
   * dictionary is NOT loaded here.
   */
  private async loadNext() {
    const nextEntry = await HistoryManager.getNextDueEntry(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      bankSources(this.plugin.settings),
      this.bank,
    );
    await this.renderPractice(nextEntry);
  }

  /** (Re)build the whole practice UI for one entry (null = no bank yet). */
  private async renderPractice(nextEntry: PracticeEntry | null) {
    // Stop any give-up animation timers from a previous writer before its
    // SVG is torn down.
    this.writer?.destroy();
    this.writer = null;
    const container = this.containerEl.children[1];
    container.empty();
    this.currentEntry = nextEntry;

    if (nextEntry && IsFlashcardEntry(nextEntry)) {
      this.renderFlashcard(container, nextEntry);
      return;
    }

    // A non-hanzi bank with no cards has nothing to fall back to (the hanzi
    // UI's default 汉 would be nonsense there).
    if (!nextEntry && this.bank !== HANZI_BANK) {
      container.createEl('h2', {text: `Practice: ${this.bank}`});
      container.createEl('p', {
        cls: 'practice-empty',
        text: `No cards in the "${this.bank}" bank yet.`,
      });
      return;
    }

    container.createEl('h2', {text: 'Practice Hanzi'});

    this.targetPinyin = '';
    this.englishDef = '';
    if (nextEntry) {
      this.currentCharacter = nextEntry.character;
      this.targetPinyin = nextEntry.pinyin;
      this.englishDef = nextEntry.english;
    }

    if (this.englishDef) {
      container.createEl('p', {
        text: `Meaning: ${this.englishDef}`,
        cls: 'hanzi-meaning',
      });
    }

    const toneSelectContainer = container.createDiv({cls: 'tone-selector'});

    // Only show the tone quiz when the character has a cached pinyin.
    if (this.targetPinyin) {
      const selector = new PinyinSelector(
        toneSelectContainer,
        this.targetPinyin,
        mistakes => {
          this.pinyinMistakes = mistakes;
        },
      );
      selector.render();
    } else {
      toneSelectContainer.createEl('span', {
        text: 'No pinyin recorded for this character.',
      });
    }

    const drawContainer = container.createDiv();
    drawContainer.id = 'hanzi-draw-container';
    drawContainer.style.width = '300px';
    drawContainer.style.height = '300px';
    drawContainer.style.border = '1px solid #ccc';
    drawContainer.style.margin = '20px 0';
    // Keep native touch gestures (scroll, mobile back-swipe) away from the
    // drawing surface; the quiz SVG blocks them too, this covers its border.
    drawContainer.style.touchAction = 'none';

    // Stroke data comes from the plugin-shipped database (lazy-loaded and
    // cached on the plugin; decoded per character) — no network, no CDN.
    this.writer = null;
    const strokeDataRes = await this.plugin.getStrokeData();
    const strokeData = strokeDataRes.ok
      ? strokeDataRes.val.get(this.currentCharacter)
      : null;
    if (strokeData) {
      this.writer = new HanziQuizWriter(
        drawContainer,
        this.currentCharacter,
        strokeData,
        {
          width: 300,
          height: 300,
          padding: 5,
        },
      );
      this.startQuiz();
    } else {
      drawContainer.createEl('span', {
        text: `No stroke data available for ${this.currentCharacter}.`,
        cls: 'hanzi-no-stroke-data',
      });
    }

    const controls = container.createDiv();
    const btnGiveUp = controls.createEl('button', {text: 'Give Up'});
    btnGiveUp.onclick = () => this.handleGiveUp();
    const btnMixUp = controls.createEl('button', {
      text: 'Mix Up',
      cls: 'hanzi-mix-up',
    });
    btnMixUp.onclick = () => void this.handleMixUp();
  }

  /**
   * Flashcard practice: show the prompt side, flip, self-grade 0–5. A
   * reversible card may show either side as the prompt.
   */
  private renderFlashcard(container: Element, entry: FlashcardEntry) {
    container.createEl('h2', {text: `Practice: ${this.bank}`});

    const reversed =
      entry.cardType === CardType.REVERSIBLE_FLASHCARD && Math.random() < 0.5;
    const card = new FlashCard(
      container as HTMLElement,
      reversed ? entry.back : entry.front,
      reversed ? entry.front : entry.back,
      score => {
        void this.handleFlashcardGrade(entry, score);
      },
    );
    card.render();
  }

  async handleFlashcardGrade(entry: FlashcardEntry, score: number) {
    await HistoryManager.appendResult(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      entry,
      score,
    );
    await this.loadNext();
  }

  startQuiz() {
    this.strokeMistakes = 0;
    this.pinyinMistakes = 0;
    this.gaveUp = false;
    this.writer?.quiz({
      onMistake: () => {
        this.strokeMistakes++;
      },
      onComplete: summaryData => {
        void this.handleQuizComplete(summaryData);
      },
    });
  }

  handleGiveUp() {
    // Show the full character, then animate it stroke by stroke. The user can
    // still trace the guided strokes to finish, but the score is locked to 0.
    this.gaveUp = true;
    this.writer?.showOutline();
    this.writer?.animateCharacter();
  }

  /**
   * Swap to a different character in the same skill range: its average
   * spaced-repetition score must be within 0.5 of the current entry's.
   */
  async handleMixUp() {
    const alternate = this.currentEntry
      ? await HistoryManager.getMixUpEntry(
          this.plugin.app,
          this.plugin.settings.historyFilePath,
          bankSources(this.plugin.settings),
          this.currentEntry,
        )
      : null;
    if (!alternate) {
      new Notice('No other character with valid score range');
      return;
    }
    await this.renderPractice(alternate);
  }

  async handleQuizComplete(summaryData: {
    character: string;
    totalMistakes: number;
  }) {
    const realTotalStrokes = this.writer?.strokeCount ?? 1;
    const percentMistakes = summaryData.totalMistakes / realTotalStrokes;

    let baseScore = 0;
    if (percentMistakes < 1e-6) baseScore = 5;
    else if (summaryData.totalMistakes === 1) baseScore = 4;
    else if (percentMistakes < 0.25) baseScore = 3;
    else if (percentMistakes < 0.5) baseScore = 2;
    else if (percentMistakes < 0.75) baseScore = 1;

    let maxDifficulty = 5;
    if (this.pinyinMistakes > 1) maxDifficulty = 3;
    else if (this.pinyinMistakes === 1) maxDifficulty = 4;

    // Giving up means the character wasn't known — tracing the revealed
    // strokes afterwards must not earn a passing grade.
    const finalScore = this.gaveUp ? 0 : Math.min(baseScore, maxDifficulty);

    // Save to history, keyed by the entry's id (char+pinyin hash) so senses
    // of the same character track their own review schedules.
    const entry: PracticeEntry = this.currentEntry ?? {
      id: computeEntryId(this.currentCharacter, this.targetPinyin),
      cardType: CardType.HANZI,
      bank: HANZI_BANK,
      character: this.currentCharacter,
      pinyin: this.targetPinyin,
      english: this.englishDef,
    };
    await HistoryManager.appendResult(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      entry,
      finalScore,
    );

    // Refresh view for next card
    void this.loadNext();
  }

  async onClose() {
    this.writer?.destroy();
    this.writer = null;
  }
}
