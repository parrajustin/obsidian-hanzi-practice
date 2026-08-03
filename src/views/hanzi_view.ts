import {ItemView, Notice, ViewStateResult, WorkspaceLeaf} from 'obsidian';
import {HANZI_VIEW_TYPE} from '../main';

import HanziPracticePlugin from '../main';
import {resolveBankSources} from '../settings';
import {HistoryManager} from '../utils/history_manager';
import {PinyinSelector} from '../components/pinyin_selector';
import {FlashCard} from '../components/flash_card';
import {MultiChoiceCard} from '../components/multi_choice_card';
import {ClozeCard} from '../components/cloze_card';
import {HanziQuizWriter} from '../writer/quiz_writer';
import {
  CardType,
  ClozeEntry,
  computeEntryId,
  FlashcardEntry,
  HANZI_BANK,
  IsClozeEntry,
  IsFlashcardEntry,
  IsMultiChoiceEntry,
  IsTrueFalseEntry,
  MultiChoiceEntry,
  PracticeEntry,
  TrueFalseEntry,
} from '../utils/practice_list';
import {
  GetTelemetry,
  LogDebug,
  LogErrorAsWarning,
  LogInfo,
  LogWarn,
  SetSpanAttribute,
  Span,
} from '../telemetry/telemetry';
import {describeEntry} from '../telemetry/card_debug';
import {CharacterIndex, LoadCharacterIndex} from '../utils/character_ledger';
import {AnnotationLookup} from '../components/annotated_text';
import {LogUiClick} from '../telemetry/ui_debug';
import {
  RecordCardGraded,
  RecordCharacterLevelUp,
  RecordCharactersCredited,
  RecordCharactersKnown,
  RecordNoIdea,
} from '../telemetry/metrics';
import {KNOWN_LEVEL} from '../character_progress';
import {WrapToResult} from 'standard-ts-lib/src/wrap_to_result';
import {WrapPromise} from 'standard-ts-lib/src/wrap_promise';

/**
 * The practice view. One view instance practices one or several BANKS as a
 * single pool (named clusters of cards — the banks are view state, set by
 * `activateView`), rendering whatever UI the due card's type needs: the
 * stroke-drawing quiz for hanzi cards, a flip-and-self-grade card for
 * (reversible) flashcards.
 */
export class HanziPracticeView extends ItemView {
  private writer: HanziQuizWriter | null = null;
  /** The practice item being quizzed; history is keyed by its id. */
  private currentEntry: PracticeEntry | null = null;
  /** When the current card was rendered — feeds the duration histogram. */
  private cardShownAt: number | null = null;
  /** The collector group scoping this practice session (leaf open → close). */
  private sessionGroupId: string | null = null;
  /**
   * The bank(s) this view is practicing. Usually one; several when the
   * practice modal's multi-select (or a whole data pack) was chosen — the
   * union then schedules as one pool.
   */
  private banks: string[] = [HANZI_BANK];
  /** Whether onOpen has run (setState before that must not render). */
  private opened = false;
  /** Whether setState has ever delivered this leaf's bank selection. */
  private bankStateReceived = false;
  /** Whether a practice session has started (session group + first load). */
  private sessionStarted = false;
  /** The deferred first load — see onOpen; cancelled once setState lands. */
  private initialLoadTimer: number | null = null;
  private currentCharacter = '汉';
  private targetPinyin = '';
  private englishDef = '';
  private strokeMistakes = 0;
  private pinyinMistakes = 0;
  /** Once Give Up is pressed, the attempt can only ever score 0. */
  private gaveUp = false;
  /** The finished quiz's summary; grading waits until the tone is also done. */
  private strokeSummary: {character: string; totalMistakes: number} | null =
    null;
  /** Whether this card quizzes the tone, and whether it has been answered. */
  private toneRequired = false;
  private toneDone = false;
  /** Completion-page timers (fade + advance); cleared on re-render/close. */
  private advanceTimers: number[] = [];
  /**
   * Readings + levels for every tracked character, reloaded with each card so
   * a character that just levelled up loses its pinyin on the very next card.
   */
  private characters: CharacterIndex = new Map();
  /** Session tallies, reported when the leaf closes. */
  private sessionStartedAt: number | null = null;
  private cardsShown = 0;
  private cardsGraded = 0;
  private plugin: HanziPracticePlugin;

  constructor(leaf: WorkspaceLeaf, plugin: HanziPracticePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return HANZI_VIEW_TYPE;
  }

  getDisplayText() {
    return this.banks.length === 1 && this.banks[0] === HANZI_BANK
      ? 'Hanzi Practice'
      : `Practice: ${this.bankLabel()}`;
  }

  /** Human-readable label for the practiced bank(s): `Capitals + German`. */
  private bankLabel(): string {
    return this.banks.join(' + ');
  }

  /**
   * The bank(s) travel as view state so reopening the tab keeps practicing
   * them. Single-bank state keeps the historical `{bank}` shape (old
   * workspace layouts must keep restoring); multi-bank state is `{banks}`.
   */
  override async setState(
    state: unknown,
    result: ViewStateResult,
  ): Promise<void> {
    await super.setState(state, result);
    const {bank, banks} =
      (state as {bank?: unknown; banks?: unknown} | null | undefined) ?? {};
    let next: string[] | null = null;
    if (
      Array.isArray(banks) &&
      banks.length > 0 &&
      banks.every(b => typeof b === 'string' && b.length > 0)
    ) {
      next = banks as string[];
    } else if (typeof bank === 'string' && bank.length > 0) {
      next = [bank];
    }
    // The leaf's real bank selection has arrived (changed or not) — this is
    // what onOpen's deferred first load is waiting for.
    if (next) this.bankStateReceived = true;
    if (next && next.join('\0') !== this.banks.join('\0')) {
      LogDebug('View state changed: practice banks switched', {
        from: this.banks,
        to: next,
        opened: this.opened,
        rawState: state,
      });
      this.banks = next;
      if (this.opened) await this.startPractice();
    } else {
      LogDebug('View setState produced no bank change', {
        banks: this.banks,
        rawState: state,
      });
      // The state Obsidian delivers right after onOpen matched the default
      // banks: nothing switched, but the deferred first load can stop
      // waiting for a switch that is never coming.
      if (this.opened && !this.sessionStarted) await this.startPractice();
    }
  }

  override getState(): Record<string, unknown> {
    return this.banks.length === 1
      ? {bank: this.banks[0]}
      : {banks: [...this.banks]};
  }

  /**
   * Obsidian opens a view BEFORE it hands it the leaf's state: `leaf.open()`
   * (which awaits this) runs first and `setState` — the bank selection the
   * user actually chose — only lands in the promise tick right after. Loading
   * a card here would therefore start a whole session for the DEFAULT bank
   * (Hanzi: stroke database, stroke quiz and all) that the user never asked
   * for, visible until the real banks arrive — the "a stroke quiz opened out
   * of nowhere" bug. So the first load waits one macrotask: the `setState`
   * that follows takes it over, and the timer only fires when no bank state
   * ever comes (e.g. an old workspace layout that recorded none).
   */
  async onOpen() {
    this.opened = true;
    // Every control the user presses inside the practice tab, in order —
    // Obsidian unregisters this with the view.
    this.registerDomEvent(this.containerEl, 'click', event =>
      LogUiClick('practice-view', event, {
        banks: this.banks,
        ...describeEntry(this.currentEntry),
      }),
    );
    if (this.bankStateReceived) {
      // State arrived before the leaf opened — nothing to wait for.
      await this.startPractice();
      return;
    }
    this.initialLoadTimer = window.setTimeout(() => {
      this.initialLoadTimer = null;
      void this.startPractice();
    }, 0);
  }

  /**
   * Begin practicing this view's banks: opens the telemetry session group the
   * first time (named after the banks that were actually resolved, not the
   * default), then loads the next due card.
   */
  private async startPractice() {
    if (this.initialLoadTimer !== null) {
      window.clearTimeout(this.initialLoadTimer);
      this.initialLoadTimer = null;
    }
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      this.sessionStartedAt = Date.now();
      // A practice session is a debug GROUP: every log, span and metric
      // emitted until the leaf closes is scoped to it, so a bug report can be
      // filed against exactly this session.
      const telemetry = GetTelemetry();
      if (telemetry.some) {
        this.sessionGroupId = telemetry
          .safeValue()
          .startGroup(`practice:${this.banks.join('+')}`);
      }
      LogInfo('Practice view opened (leaf)', {
        banks: this.banks,
        viewType: HANZI_VIEW_TYPE,
        displayText: this.getDisplayText(),
      });
    }
    await this.loadNext();
  }

  /**
   * Pick the next due card of this view's bank and render it. For hanzi
   * cards the pinyin + definition are read straight from the practice list
   * (they were cached there when the character was added) — the heavy CEDICT
   * dictionary is NOT loaded here.
   */
  @Span()
  private async loadNext() {
    SetSpanAttribute('practice.banks', this.banks.join(','));
    const {sources, packGroups, packErrors} = await resolveBankSources(
      this.plugin.app,
      this.plugin.settings,
    );
    // Which banks are in play, and where their cards come from: the first
    // thing to check when "my card never shows up".
    LogDebug('Resolved practice bank sources', {
      requestedBanks: this.banks,
      availableSources: sources.map(source => ({
        name: source.name,
        filePath: source.filePath,
      })),
      dataPackGroups: packGroups.map(group => ({
        name: group.name,
        filePath: group.filePath,
        banks: group.bankNames,
      })),
      brokenDataPacks: packErrors.map(packError => packError.filePath),
    });
    const history = await HistoryManager.parseHistory(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
    );
    // The reading source for card annotations. Read from the generated ledger
    // (small) rather than CEDICT (10MB): the practice view never loads the
    // dictionary — see the plugin's enrich-on-write rule.
    this.characters = await LoadCharacterIndex(
      this.plugin.app,
      this.plugin.settings.characterFilePath,
      entry => HistoryManager.reviewsForEntry(history, entry),
    );
    const known = [...this.characters.values()].filter(
      character => character.level >= KNOWN_LEVEL,
    ).length;
    LogDebug('Character readings loaded for annotation', {
      tracked: this.characters.size,
      known,
      filePath: this.plugin.settings.characterFilePath,
    });
    RecordCharactersKnown(known, this.characters.size);
    const nextEntry = await HistoryManager.getNextDueEntry(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      sources,
      this.banks,
    );
    LogInfo('Next due card selected', {
      banks: this.banks,
      ...describeEntry(nextEntry),
    });
    await this.renderPractice(nextEntry);
  }

  /** (Re)build the whole practice UI for one entry (null = no bank yet). */
  private async renderPractice(nextEntry: PracticeEntry | null) {
    // Stop any give-up animation timers from a previous writer before its
    // SVG is torn down, and any pending completion-page advance.
    this.clearAdvanceTimers();
    this.writer?.destroy();
    this.writer = null;
    this.strokeSummary = null;
    this.toneRequired = false;
    this.toneDone = false;
    const container = this.containerEl.children[1];
    container.empty();
    this.currentEntry = nextEntry;
    // Starts the clock for the card-duration histogram.
    this.cardShownAt = nextEntry === null ? null : Date.now();

    if (nextEntry && IsFlashcardEntry(nextEntry)) {
      this.logCardShown('flashcard', nextEntry);
      this.renderFlashcard(container, nextEntry);
      return;
    }

    if (nextEntry && IsMultiChoiceEntry(nextEntry)) {
      this.logCardShown('multi-choice', nextEntry);
      this.renderMultiChoice(container, nextEntry);
      return;
    }

    if (nextEntry && IsClozeEntry(nextEntry)) {
      this.logCardShown('cloze', nextEntry);
      this.renderCloze(container, nextEntry);
      return;
    }

    if (nextEntry && IsTrueFalseEntry(nextEntry)) {
      this.logCardShown('true-false', nextEntry);
      this.renderTrueFalse(container, nextEntry);
      return;
    }

    // A non-hanzi bank with no cards has nothing to fall back to (the hanzi
    // UI's default 汉 would be nonsense there).
    if (!nextEntry && !this.banks.includes(HANZI_BANK)) {
      LogInfo('Rendered empty-bank message (no cards to practice)', {
        banks: this.banks,
        renderer: 'empty',
      });
      container.createEl('h2', {text: `Practice: ${this.bankLabel()}`});
      container.createEl('p', {
        cls: 'practice-empty',
        text:
          this.banks.length === 1
            ? `No cards in the "${this.banks[0]}" bank yet.`
            : `No cards in the selected banks (${this.bankLabel()}) yet.`,
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
      this.toneRequired = true;
      const selector = new PinyinSelector(
        toneSelectContainer,
        this.targetPinyin,
        mistakes => {
          this.pinyinMistakes = mistakes;
          this.toneDone = true;
          LogInfo('Tone answered', {
            character: this.currentCharacter,
            correctPinyin: this.targetPinyin,
            pinyinMistakes: mistakes,
            strokesDone: this.strokeSummary !== null,
            ...describeEntry(nextEntry),
          });
          this.maybeFinishAttempt();
        },
        pick => this.logOptionPick('tone-selector', nextEntry, pick),
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
      this.logCardShown('hanzi-quiz', nextEntry, {
        character: this.currentCharacter,
        strokeCount: this.writer.strokeCount,
        toneRequired: this.toneRequired,
        hasMeaning: this.englishDef !== '',
      });
      this.startQuiz();
    } else {
      // The character has no entry in the shipped stroke database — the quiz
      // cannot render, which is a common "nothing happens" bug report.
      LogWarn('No stroke data for character; quiz not rendered', {
        character: this.currentCharacter,
        strokeDatabaseLoaded: strokeDataRes.ok,
        ...describeEntry(nextEntry),
      });
      this.logCardShown('hanzi-no-stroke-data', nextEntry, {
        character: this.currentCharacter,
        toneRequired: this.toneRequired,
      });
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
    container.createEl('h2', {text: `Practice: ${this.bankLabel()}`});

    const reversed =
      entry.cardType === CardType.REVERSIBLE_FLASHCARD && Math.random() < 0.5;
    // WHICH side is the prompt is random for reversible cards — without this
    // line a "wrong side shown" report is impossible to reproduce.
    LogDebug('Flashcard prompt side chosen', {
      id: entry.id,
      reversed,
      promptSide: reversed ? 'back' : 'front',
      promptText: reversed ? entry.back : entry.front,
    });
    const card = new FlashCard(
      container as HTMLElement,
      reversed ? entry.back : entry.front,
      reversed ? entry.front : entry.back,
      score => this.gradeCard(entry, score),
      entry.explanation,
      () =>
        LogInfo('User action: revealed the answer', {
          renderer: 'flashcard',
          secondsThinking: this.secondsOnCard(),
          ...describeEntry(entry),
        }),
      this.annotation(),
    );
    card.render();
  }

  /**
   * Multiple-choice practice: pick the answer among shuffled distractors.
   * Auto-graded from the wrong picks with no partial credit — with so few
   * options one wrong pick reveals too much: 0 mistakes → 5, any → 0.
   */
  private renderMultiChoice(container: Element, entry: MultiChoiceEntry) {
    container.createEl('h2', {text: `Practice: ${this.bankLabel()}`});

    const card = new MultiChoiceCard(
      container as HTMLElement,
      entry.question,
      entry.answer,
      entry.distractors,
      mistakes => this.gradeCard(entry, mistakes === 0 ? 5 : 0),
      {
        explanation: entry.explanation,
        onPick: pick => this.logOptionPick('multi-choice', entry, pick),
        onNoIdea: () => this.handleNoIdea('multi-choice', entry),
        annotate: this.annotation(),
      },
    );
    card.render();
  }

  /**
   * Cloze practice: the sentence is shown with its `{{…}}` answers blanked;
   * reveal, then self-grade 0–5 exactly like a flashcard.
   */
  private renderCloze(container: Element, entry: ClozeEntry) {
    container.createEl('h2', {text: `Practice: ${this.bankLabel()}`});

    const card = new ClozeCard(
      container as HTMLElement,
      entry.text,
      entry.hint,
      score => this.gradeCard(entry, score),
      entry.explanation,
      () =>
        LogInfo('User action: revealed the answer', {
          renderer: 'cloze',
          secondsThinking: this.secondsOnCard(),
          ...describeEntry(entry),
        }),
      this.annotation(),
    );
    card.render();
  }

  /**
   * True/false practice: the multi-choice UI with Correct/Incorrect as the
   * two options under an "Is this correct?" prompt. Auto-graded — with only
   * two options a wrong pick reveals the answer, so there is no partial
   * credit: right first pick → 5, any mistake → 0.
   */
  private renderTrueFalse(container: Element, entry: TrueFalseEntry) {
    container.createEl('h2', {text: `Practice: ${this.bankLabel()}`});

    const card = new MultiChoiceCard(
      container as HTMLElement,
      entry.statement,
      entry.isCorrect ? 'Correct' : 'Incorrect',
      [entry.isCorrect ? 'Incorrect' : 'Correct'],
      mistakes => this.gradeCard(entry, mistakes === 0 ? 5 : 0),
      {
        prompt: 'Is this correct?',
        explanation: entry.explanation,
        onPick: pick => this.logOptionPick('true-false', entry, pick),
        onNoIdea: () => this.handleNoIdea('true-false', entry),
        annotate: this.annotation(),
      },
    );
    card.render();
  }

  /**
   * Grade a non-hanzi card. A failed card (<3) that carries a wrong-answer
   * explanation just had it revealed by its component, so the advance waits
   * 2.5s (same pause as the hanzi completion page; timers are cleared on
   * re-render/close) — otherwise the next card loads immediately.
   */
  /**
   * One line per card actually put on screen: which RENDERER drew it, the
   * card's identity and format, and how long the previous card was up. This
   * is the backbone of the debug trail — "what was I looking at, exactly".
   */
  /**
   * The reading to print above each character of a card. Undefined when the
   * ledger is empty (no sync yet) so cards render exactly as they did before
   * annotations existed rather than sprouting empty lines.
   */
  private annotation(): AnnotationLookup | undefined {
    if (this.characters.size === 0) return undefined;
    return char => this.characters.get(char);
  }

  /** How long the current card has been on screen, for user-action logs. */
  private secondsOnCard(): number | undefined {
    if (this.cardShownAt === null) return undefined;
    return Math.round((Date.now() - this.cardShownAt) / 100) / 10;
  }

  /**
   * One answer button press on an auto-graded card (multiple choice,
   * true/false, tone) — right or wrong, with the option's text, so a "it
   * marked me wrong" report can be read back pick by pick.
   */
  private logOptionPick(
    renderer: string,
    entry: PracticeEntry | null,
    pick: {option: string; correct: boolean; mistakes: number},
  ): void {
    LogInfo('User action: picked an answer', {
      renderer,
      option: pick.option,
      correct: pick.correct,
      mistakesSoFar: pick.mistakes,
      secondsThinking: this.secondsOnCard(),
      ...describeEntry(entry),
    });
  }

  private logCardShown(
    renderer: string,
    entry: PracticeEntry | null,
    extra?: Record<string, unknown>,
  ): void {
    this.cardsShown++;
    LogInfo('Card shown', {
      renderer,
      banks: this.banks,
      cardNumberInSession: this.cardsShown,
      ...describeEntry(entry),
      ...extra,
    });
  }

  /**
   * "No Idea" on an auto-graded card: score 0 without guessing. Logged as its
   * own action because a 0 the user CHOSE is different evidence from a 0 they
   * earned by picking wrong — one says "never seen it", the other "confused
   * it with something".
   */
  private handleNoIdea(renderer: string, entry: PracticeEntry) {
    LogInfo('User action: No Idea (declined to guess)', {
      renderer,
      secondsThinking: this.secondsOnCard(),
      ...describeEntry(entry),
    });
    RecordNoIdea(String(entry.cardType ?? CardType.HANZI), entry.bank);
    this.gradeCard(entry, 0);
  }

  private gradeCard(entry: PracticeEntry, score: number) {
    if (score < 3 && entry.explanation) {
      LogDebug('Card failed with an explanation: pausing before advance', {
        id: entry.id,
        score,
        pauseMs: 2500,
      });
      void this.persistGrade(entry, score);
      this.advanceTimers.push(
        window.setTimeout(() => {
          void this.loadNext();
        }, 2500),
      );
      return;
    }
    void this.handleCardGrade(entry, score);
  }

  /** Append one graded review to history and advance to the next due card. */
  async handleCardGrade(entry: PracticeEntry, score: number) {
    await this.persistGrade(entry, score);
    await this.loadNext();
  }

  /**
   * The single choke point every graded card passes through: records the
   * practice metrics (count, grade distribution, time spent) and writes the
   * review to history.
   */
  private async persistGrade(entry: PracticeEntry, score: number) {
    RecordCardGraded(
      {
        cardType: String(entry.cardType ?? CardType.HANZI),
        bank: entry.bank,
      },
      score,
      this.cardShownAt === null ? undefined : Date.now() - this.cardShownAt,
    );
    const durationMs =
      this.cardShownAt === null ? undefined : Date.now() - this.cardShownAt;
    this.cardsGraded++;
    LogInfo('Card graded', {
      ...describeEntry(entry),
      score,
      passed: score >= 3,
      durationMs,
      gradedInSession: this.cardsGraded,
    });
    await HistoryManager.appendResult(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      entry,
      score,
    );
    // Answering a sentence is evidence about the characters in it, not just
    // about the card: this is what walks a character towards level 4 (and
    // towards losing its printed reading) without ever drilling it alone.
    const credit = await HistoryManager.creditCharacters(
      this.plugin.app,
      this.plugin.settings.historyFilePath,
      entry,
      score,
      this.characters,
    );
    RecordCharactersCredited(
      String(entry.cardType ?? CardType.HANZI),
      credit.credited.length,
    );
    for (const char of credit.levelUps) {
      // The moment a card visibly changes for the user — worth its own line.
      LogInfo('Character reached the known level; its pinyin is now hidden', {
        character: char,
        knownLevel: KNOWN_LEVEL,
        fromCard: entry.id,
        score,
      });
      RecordCharacterLevelUp(char);
    }
    // Keep the daily-volume gauge honest without re-reading history on every
    // metric collection. Best-effort and un-awaited: this is telemetry
    // bookkeeping, so neither a slow read nor a missing method may delay or
    // break the user's grade.
    const refresh = WrapToResult(
      () => this.plugin.refreshReviewCounts(),
      /*textForUnknown=*/ 'Failed to refresh review counts',
    );
    if (refresh.err) {
      LogErrorAsWarning(
        'Could not refresh practice volume counts',
        refresh.val,
      );
      return;
    }
    void WrapPromise(
      refresh.safeUnwrap(),
      /*textForUnknown=*/ 'Failed to refresh review counts',
    ).then(result => {
      if (result.err) {
        LogErrorAsWarning(
          'Could not refresh practice volume counts',
          result.val,
        );
      }
    });
  }

  startQuiz() {
    this.strokeMistakes = 0;
    this.pinyinMistakes = 0;
    this.gaveUp = false;
    this.strokeSummary = null;
    LogDebug('Stroke quiz started', {
      character: this.currentCharacter,
      strokeCount: this.writer?.strokeCount ?? 0,
      toneRequired: this.toneRequired,
    });
    this.writer?.quiz({
      onMistake: data => {
        this.strokeMistakes++;
        LogDebug('Stroke rejected', {
          character: this.currentCharacter,
          strokeNum: data.strokeNum,
          mistakesOnStroke: data.mistakesOnStroke,
          strokeMistakes: this.strokeMistakes,
          gaveUp: this.gaveUp,
        });
      },
      // The per-stroke progress track: paired with the rejections above it
      // says exactly which stroke a "it won't accept my drawing" report is
      // stuck on.
      onCorrectStroke: data =>
        LogDebug('Stroke accepted', {
          character: this.currentCharacter,
          strokeNum: data.strokeNum,
          strokesRemaining: data.strokesRemaining,
          strokeMistakesSoFar: this.strokeMistakes,
        }),
      onComplete: summaryData => {
        // The stroke portion is done (the writer highlights the drawing
        // area's edge); grading waits until the tone is also answered.
        this.strokeSummary = summaryData;
        LogDebug('Stroke portion complete', {
          character: summaryData.character,
          totalMistakes: summaryData.totalMistakes,
          toneRequired: this.toneRequired,
          toneDone: this.toneDone,
        });
        this.maybeFinishAttempt();
      },
    });
  }

  /** Grade once BOTH the strokes and the tone (when quizzed) are finished. */
  private maybeFinishAttempt() {
    if (!this.strokeSummary) {
      LogDebug('Attempt not finishable yet: strokes outstanding', {
        character: this.currentCharacter,
        toneDone: this.toneDone,
      });
      return;
    }
    if (this.toneRequired && !this.toneDone) {
      LogDebug('Attempt not finishable yet: tone outstanding', {
        character: this.currentCharacter,
      });
      return;
    }
    void this.handleQuizComplete(this.strokeSummary);
  }

  handleGiveUp() {
    // Reveal the character (animated stroke by stroke) and enter guided
    // practice: the current stroke flashes while the user traces each one.
    // After the last traced stroke the writer replays the animation and the
    // user must draw the whole character unguided before the quiz completes —
    // but the score stays locked to 0.
    LogInfo('User action: Give Up (score locks to 0)', {
      character: this.currentCharacter,
      strokeMistakesSoFar: this.strokeMistakes,
      hasWriter: this.writer !== null,
      ...describeEntry(this.currentEntry),
    });
    this.gaveUp = true;
    this.writer?.startGuidedPractice();
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
          (await resolveBankSources(this.plugin.app, this.plugin.settings))
            .sources,
          this.currentEntry,
        )
      : null;
    if (!alternate) {
      LogInfo('User action: Mix Up found no alternate character', {
        ...describeEntry(this.currentEntry),
      });
      new Notice('No other character with valid score range');
      return;
    }
    LogInfo('User action: Mix Up swapped the character', {
      from: describeEntry(this.currentEntry),
      to: describeEntry(alternate),
    });
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

    // Every input to the grade, so a "wrong score" report can be replayed
    // arithmetically instead of guessed at.
    LogInfo('Hanzi attempt graded', {
      character: summaryData.character,
      totalStrokes: realTotalStrokes,
      strokeMistakes: summaryData.totalMistakes,
      percentMistakes,
      baseScore,
      pinyinMistakes: this.pinyinMistakes,
      maxDifficulty,
      gaveUp: this.gaveUp,
      finalScore,
    });

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

    // Show the completion page; it fades after 2.5s, then the next card
    // loads.
    this.showCompletionPage(finalScore);
  }

  /**
   * "You have completed <char> (<definition>). Your score was <n>" — shown
   * for 2.5s, then faded out, then the view advances to the next due card.
   */
  private showCompletionPage(score: number) {
    LogDebug('Rendered hanzi completion page', {
      renderer: 'hanzi-completion',
      character: this.currentCharacter,
      score,
      showsExplanation: score < 3 && Boolean(this.currentEntry?.explanation),
    });
    this.writer?.destroy();
    this.writer = null;
    const container = this.containerEl.children[1];
    container.empty();
    const page = container.createDiv({cls: 'hanzi-complete-summary'});
    const label = this.englishDef
      ? `${this.currentCharacter} (${this.englishDef})`
      : this.currentCharacter;
    page.createEl('h2', {text: `You have completed ${label}`});
    page.createEl('p', {
      text: `Your score was ${score}`,
      cls: 'hanzi-complete-score',
    });
    // Failed hanzi cards surface their wrong-answer correction here — the
    // completion page is the one moment the user is looking at the result.
    if (score < 3 && this.currentEntry?.explanation) {
      page.createEl('p', {
        text: this.currentEntry.explanation,
        cls: 'hanzi-complete-explanation',
      });
    }
    page.style.opacity = '1';
    page.style.transition = 'opacity 0.4s ease';
    this.advanceTimers.push(
      window.setTimeout(() => {
        page.style.opacity = '0';
      }, 2500),
      window.setTimeout(() => {
        void this.loadNext();
      }, 2900),
    );
  }

  private clearAdvanceTimers() {
    for (const t of this.advanceTimers) window.clearTimeout(t);
    this.advanceTimers = [];
  }

  async onClose() {
    // "I left the plugin": what the session amounted to, so a report can be
    // read as a whole sitting rather than a stream of isolated cards.
    LogInfo('User action: left the practice view (leaf closed)', {
      banks: this.banks,
      lastCard: describeEntry(this.currentEntry),
      cardsShown: this.cardsShown,
      cardsGraded: this.cardsGraded,
      sessionSeconds:
        this.sessionStartedAt === null
          ? undefined
          : Math.round((Date.now() - this.sessionStartedAt) / 1000),
      abandonedMidCard: this.currentEntry !== null && this.cardShownAt !== null,
      pendingAdvanceTimers: this.advanceTimers.length,
    });
    this.clearAdvanceTimers();
    // A leaf closed inside the state-settling window must not start a session
    // on its way out.
    if (this.initialLoadTimer !== null) {
      window.clearTimeout(this.initialLoadTimer);
      this.initialLoadTimer = null;
    }
    this.writer?.destroy();
    this.writer = null;
    // Close the session group opened in onOpen, so the collector never keeps
    // a ghost group open for a leaf that is gone.
    const telemetry = GetTelemetry();
    if (telemetry.some && this.sessionGroupId !== null) {
      telemetry.safeValue().endGroup(this.sessionGroupId);
      this.sessionGroupId = null;
    }
  }
}
