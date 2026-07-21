import {ItemView, Notice, WorkspaceLeaf} from 'obsidian';
import {HANZI_VIEW_TYPE} from '../main';

import HanziPracticePlugin from '../main';
import {HistoryManager} from '../utils/history_manager';
import {PinyinSelector} from '../components/pinyin_selector';
import {HanziQuizWriter} from '../writer/quiz_writer';
import {computeEntryId, PracticeEntry} from '../utils/practice_list';

export class HanziPracticeView extends ItemView {
  private writer: HanziQuizWriter | null = null;
  /** The practice item (sense) being quizzed; history is keyed by its id. */
  private currentEntry: PracticeEntry | null = null;
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
    return 'Hanzi Practice';
  }

  async onOpen() {
    // Pick the next due character, then read its pinyin + definition straight
    // from the practice list (they were cached there when the character was
    // added). The heavy CEDICT dictionary is NOT loaded here.
    const nextEntry = await HistoryManager.getNextDueEntry(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      this.plugin.settings.practiceFilePath,
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

    container.createEl('h2', {text: 'Practice Hanzi'});

    this.targetPinyin = '';
    this.englishDef = '';
    this.currentEntry = nextEntry;
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
          this.plugin.settings.practiceFilePath,
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

    // Refresh view for next char
    void this.onOpen();
  }

  async onClose() {
    this.writer?.destroy();
    this.writer = null;
  }
}
