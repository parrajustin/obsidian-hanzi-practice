import {ItemView, WorkspaceLeaf} from 'obsidian';
import {HANZI_VIEW_TYPE} from '../main';

import HanziPracticePlugin from '../main';
import {HistoryManager} from '../utils/history_manager';
import {PinyinSelector} from '../components/pinyin_selector';
import {HanziQuizWriter} from '../writer/quiz_writer';

export class HanziPracticeView extends ItemView {
  private writer: HanziQuizWriter | null = null;
  private currentCharacter = '汉';
  private targetPinyin = '';
  private englishDef = '';
  private strokeMistakes = 0;
  private pinyinMistakes = 0;
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
    const container = this.containerEl.children[1];
    container.empty();

    container.createEl('h2', {text: 'Practice Hanzi'});

    // Pick the next due character, then read its pinyin + definition straight
    // from the practice list (they were cached there when the character was
    // added). The heavy CEDICT dictionary is NOT loaded here.
    this.targetPinyin = '';
    this.englishDef = '';
    const nextChar = await HistoryManager.getNextDueCharacter(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      this.plugin.settings.practiceFilePath,
    );
    if (nextChar) {
      this.currentCharacter = nextChar;
      const entry = await HistoryManager.getPracticeEntry(
        this.plugin.app,
        this.plugin.settings.practiceFilePath,
        nextChar,
      );
      if (entry) {
        this.targetPinyin = entry.pinyin;
        this.englishDef = entry.english;
      }
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

    // Stroke medians come from the plugin-shipped database (lazy-loaded and
    // cached on the plugin; decoded per character) — no network, no CDN.
    this.writer = null;
    const strokeDataRes = await this.plugin.getStrokeData();
    const medians = strokeDataRes.ok
      ? strokeDataRes.val.get(this.currentCharacter)
      : null;
    if (medians) {
      this.writer = new HanziQuizWriter(
        drawContainer,
        this.currentCharacter,
        medians,
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
  }

  startQuiz() {
    this.strokeMistakes = 0;
    this.pinyinMistakes = 0;
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
    // Show the full character skeleton, then animate it stroke by stroke.
    this.writer?.showOutline();
    this.writer?.animateCharacter();
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

    const finalScore = Math.min(baseScore, maxDifficulty);

    // Save to history
    await HistoryManager.appendResult(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      this.currentCharacter,
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
