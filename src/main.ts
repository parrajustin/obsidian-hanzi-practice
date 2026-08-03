import {apiVersion, Notice, Plugin, WorkspaceLeaf} from 'obsidian';
import {
  FileSystemType,
  FileUtil,
} from 'standard-obsidian-lib/src/filesystem/file_util';
import {None, Optional, Some} from 'standard-ts-lib/src/optional';
import {
  DEFAULT_CHARACTER_FILE,
  HanziPluginSettings,
  HanziSettingTab,
  resolveBankSources,
  SETTINGS_SCHEMA,
} from './settings';
import {LedgerSyncSummary, SyncCharacterLedger} from './utils/character_ledger';
import {ProgressFor} from './character_progress';
import {StripPinyinFromCardFile} from './utils/migrate_pinyin';
import {CHARACTER_BANK} from './utils/practice_list';
import {HanziPracticeView} from './views/hanzi_view';
import {AddCharacterModal} from './commands/add_character_modal';
import {AddFlashcardModal} from './commands/add_flashcard_modal';
import {EditBankModal} from './commands/edit_bank_modal';
import {PracticeBankModal} from './commands/practice_bank_modal';
import {HANZI_BANK} from './utils/practice_list';
import {CedictParser} from './dictionary/cedict_parser';
import {StrokeDataReader} from './data/stroke_codec';
import {loadStrokeData} from './data/stroke_data';
import {Ok, Result} from 'standard-ts-lib/src/result';
import {StatusError} from 'standard-ts-lib/src/status_error';
import {
  GetTelemetry,
  InitTelemetry,
  LogError,
  LogDebug,
  LogInfo,
  ResetTelemetry,
  SetSpanAttribute,
  Span,
} from './telemetry/telemetry';
import {
  ObserveCardsToday,
  RecordCardsPerDay,
  ResetMetrics,
} from './telemetry/metrics';
import {countReviewsByDay, dayKeyFor} from './telemetry/practice_volume';
import {HistoryManager} from './utils/history_manager';

export const HANZI_VIEW_TYPE = 'hanzi-practice-view';

// The CEDICT dictionary is shipped gzipped alongside main.js in the plugin
// folder. It is only read when adding a character (to cache pinyin + def into
// the practice list) — never on the hot path of opening the practice view.
export const CEDICT_FILE = 'cedict_1_0_ts_utf-8_mdbg_20240705_025126.txt.gz';

// The stroke database (medians + glyph outlines, generated at build time from
// hanzi-writer-data), also shipped gzipped next to main.js. The reader keeps
// the blob compressed-in-file / raw-in-memory and decodes one character at a
// time, so loading it is cheap enough for the practice view's open path.
export const STROKES_FILE = 'hanzi-strokes.bin.gz';

export default class HanziPracticePlugin extends Plugin {
  settings!: HanziPluginSettings;
  private dictionary: CedictParser | null = null;
  private strokeData: StrokeDataReader | null = null;
  /** Reviews per local day, refreshed from history; drives the volume metrics. */
  private reviewCountsByDay = new Map<string, number>();

  /**
   * Lazily load + parse the CEDICT dictionary, caching it for the plugin's
   * lifetime so repeated "add character" actions don't re-parse ~10MB each time.
   */
  @Span()
  async getDictionary(): Promise<Result<CedictParser, StatusError>> {
    if (this.dictionary) return Ok(this.dictionary);
    const parser = new CedictParser();
    const dictPath = this.manifest.dir
      ? `${this.manifest.dir}/${CEDICT_FILE}`
      : CEDICT_FILE;
    SetSpanAttribute('dictionary.path', dictPath);
    const started = Date.now();
    const res = await parser.loadDictionary(this.app, dictPath);
    if (!res.ok) {
      LogError('Failed to load CEDICT dictionary', res.val, {dictPath});
      return res as unknown as Result<CedictParser, StatusError>;
    }
    this.dictionary = parser;
    LogInfo('CEDICT dictionary loaded', {
      dictPath,
      durationMs: Date.now() - started,
    });
    return Ok(parser);
  }

  /** Lazily load the stroke database, cached for the plugin's lifetime. */
  @Span()
  async getStrokeData(): Promise<Result<StrokeDataReader, StatusError>> {
    if (this.strokeData) return Ok(this.strokeData);
    const dataPath = this.manifest.dir
      ? `${this.manifest.dir}/${STROKES_FILE}`
      : STROKES_FILE;
    SetSpanAttribute('strokes.path', dataPath);
    const started = Date.now();
    const res = await loadStrokeData(this.app, dataPath);
    if (!res.ok) {
      LogError('Failed to load stroke database', res.val, {dataPath});
      return res;
    }
    this.strokeData = res.val;
    LogInfo('Stroke database loaded', {
      dataPath,
      durationMs: Date.now() - started,
    });
    return Ok(this.strokeData);
  }

  async onload() {
    // FIRST: telemetry, so everything below (including settings failures) is
    // reported. InitTelemetry never throws — with no Bug Collector installed
    // it logs one console error and every helper degrades to a no-op.
    const telemetry = InitTelemetry(this.manifest.version, {
      'obsidian.version': apiVersion,
      'plugin.name': this.manifest.name,
    });
    if (telemetry.some) {
      // Opens this run's session group: every record below is attributed to
      // it, and it is what the bug-report dropdown offers.
      telemetry.safeValue().start();
    }
    LogInfo('Plugin loading', {version: this.manifest.version});

    await this.loadSettings();
    this.reportDailyPracticeVolume();

    this.addSettingTab(
      new HanziSettingTab(this.app, this, this.settings, async settings => {
        this.settings = settings;
        await this.saveData(this.settings);
      }),
    );

    this.registerView(
      HANZI_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new HanziPracticeView(leaf, this),
    );

    this.registerPracticeFocusLogging();

    this.addCommand({
      id: 'open-hanzi-practice',
      name: 'Open Hanzi Practice View',
      callback: () => {
        LogInfo('Command invoked', {command: 'open-hanzi-practice'});
        void this.activateView();
      },
    });

    // The general entry point: pick a bank, then practice its cards with
    // whatever UI each card type needs.
    this.addCommand({
      id: 'practice',
      name: 'Practice (Choose Bank)',
      callback: () => {
        LogInfo('Command invoked', {command: 'practice', modal: 'choose-bank'});
        new PracticeBankModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: 'add-hanzi-character',
      name: 'Add Hanzi Character to Practice',
      callback: () => {
        LogInfo('Command invoked', {
          command: 'add-hanzi-character',
          modal: 'add-character',
        });
        new AddCharacterModal(this.app, this).open();
      },
    });

    // Id kept from when the modal only added flashcards (renaming command
    // ids breaks users' hotkey bindings); it now adds every non-hanzi type.
    this.addCommand({
      id: 'add-flash-card',
      name: 'Add Card to Practice',
      callback: () => {
        LogInfo('Command invoked', {
          command: 'add-flash-card',
          modal: 'add-card',
        });
        new AddFlashcardModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: 'sync-character-progress',
      name: 'Sync Character Progress',
      callback: () => {
        LogInfo('Command invoked', {command: 'sync-character-progress'});
        void this.runCharacterSync();
      },
    });

    this.addCommand({
      id: 'strip-embedded-pinyin',
      name: 'Migrate Cards: Remove Embedded Pinyin',
      callback: () => {
        LogInfo('Command invoked', {command: 'strip-embedded-pinyin'});
        void this.runPinyinMigration();
      },
    });

    // Id kept from when the plugin was hanzi-only (renaming command ids
    // breaks users' hotkey bindings); it now edits every bank.
    this.addCommand({
      id: 'edit-hanzi-bank',
      name: 'Edit Practice Banks',
      callback: () => {
        LogInfo('Command invoked', {
          command: 'edit-hanzi-bank',
          modal: 'edit-banks',
        });
        new EditBankModal(this.app, this).open();
      },
    });

    LogInfo('Plugin loaded', {
      version: this.manifest.version,
      historyFilePath: this.settings.historyFilePath,
      practiceFilePath: this.settings.practiceFilePath,
      banks: this.settings.banks.map(bank => ({
        name: bank.name,
        filePath: bank.filePath,
      })),
      dataPacks: this.settings.dataPacks.map(pack => pack.filePath),
      commands: [
        'open-hanzi-practice',
        'practice',
        'add-hanzi-character',
        'add-flash-card',
        'edit-hanzi-bank',
      ],
    });
  }

  /**
   * Practice-volume metrics. Two instruments, because they answer different
   * questions: an observable gauge re-reads TODAY's count on every metric
   * collection (a live number that keeps changing), while the histogram takes
   * exactly one observation of YESTERDAY — a completed day, so the value is
   * final and each day contributes one sample.
   */
  private reportDailyPracticeVolume(): void {
    ObserveCardsToday(() => this.reviewCountsByDay.get(dayKeyFor(0)) ?? 0);
    void this.refreshReviewCounts().then(() => {
      RecordCardsPerDay(this.reviewCountsByDay.get(dayKeyFor(-1)) ?? 0);
    });
  }

  /** Re-read the history file into the per-day review counts. */
  async refreshReviewCounts(): Promise<void> {
    const history = await HistoryManager.parseHistory(
      this.app,
      this.settings.historyFilePath,
    );
    this.reviewCountsByDay = countReviewsByDay(history);
  }

  @Span()
  async activateView(banks: string | string[] = HANZI_BANK) {
    const {workspace} = this.app;

    // Reuse an existing practice tab if one is already open.
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(HANZI_VIEW_TYPE)[0] ?? null;
    const reusedExistingLeaf = leaf !== null;

    if (!leaf) {
      // getLeaf('tab') opens a new tab in the main (center) editor area,
      // never in the left/right sidebars.
      leaf = workspace.getLeaf('tab');
    }
    LogInfo('Activating practice view', {
      requestedBanks: banks,
      reusedExistingLeaf,
      openLeaves: workspace.getLeavesOfType(HANZI_VIEW_TYPE).length,
    });

    // Always set the state: an already-open practice tab switches to the
    // chosen bank(s) (view state — see HanziPracticeView.setState; single
    // banks keep the historical {bank} shape).
    const bankList = typeof banks === 'string' ? [banks] : banks;
    const state =
      bankList.length === 1 ? {bank: bankList[0]} : {banks: bankList};
    LogDebug('Setting practice view state', {state, bankList});
    await leaf.setViewState({
      type: HANZI_VIEW_TYPE,
      active: true,
      state,
    });
    await workspace.revealLeaf(leaf);
  }

  /**
   * Rebuild the character ledger from every card in every bank: the one place
   * the 10MB dictionary is read on this path, which is exactly why it is a
   * command and not something the practice view does.
   */
  async runCharacterSync(): Promise<Optional<LedgerSyncSummary>> {
    const dictionary = await this.getDictionary();
    if (!dictionary.ok) {
      new Notice(`Character sync failed: ${dictionary.val.message}`);
      return None;
    }
    const {sources} = await resolveBankSources(this.app, this.settings);
    const entries = await HistoryManager.loadAllPracticeEntries(
      this.app,
      sources,
    );
    const history = await HistoryManager.parseHistory(
      this.app,
      this.settings.historyFilePath,
    );
    const synced = await SyncCharacterLedger(
      this.app,
      this.settings.characterFilePath,
      entries,
      dictionary.val,
      entry =>
        ProgressFor(
          entry.character,
          HistoryManager.reviewsForEntry(history, entry),
        ),
    );
    if (!synced.ok) {
      LogError('Character sync failed', synced.val, {
        filePath: this.settings.characterFilePath,
      });
      new Notice(`Character sync failed: ${synced.val.message}`);
      return None;
    }
    const summary = synced.val;
    new Notice(
      `Character progress synced — ${summary.total} characters ` +
        `(${summary.added} new` +
        `${summary.unknown.length > 0 ? `, ${summary.unknown.length} without a dictionary entry` : ''}).`,
    );
    return Some(summary);
  }

  /**
   * Take the embedded readings out of every card file, then re-sync so the
   * readings the cards just lost are available from the ledger instead. The
   * id column is preserved line by line, so no card loses its history.
   */
  async runPinyinMigration(): Promise<{files: number; cards: number}> {
    const {sources} = await resolveBankSources(this.app, this.settings);
    let files = 0;
    let cards = 0;
    for (const source of sources) {
      // The ledger is generated from the dictionary; it never carried an
      // embedded reading to strip.
      if (source.name === CHARACTER_BANK) continue;
      const read = await FileUtil.fetchFile(
        this.app,
        source.filePath,
        FileSystemType.OBSIDIAN,
      );
      if (!read.ok) continue;
      const text = new TextDecoder('utf-8').decode(read.val);
      const migrated = StripPinyinFromCardFile(text);
      if (migrated.changed === 0) continue;
      const written = await FileUtil.writeToFile(
        this.app,
        source.filePath,
        new TextEncoder().encode(migrated.text),
        FileSystemType.OBSIDIAN,
      );
      if (written.err) {
        LogError('Could not rewrite a bank file', written.val, {
          bank: source.name,
          filePath: source.filePath,
        });
        continue;
      }
      files++;
      cards += migrated.changed;
      LogInfo('Stripped embedded pinyin from a bank', {
        bank: source.name,
        filePath: source.filePath,
        cards: migrated.changed,
      });
    }
    LogInfo('Pinyin migration finished', {files, cards});
    new Notice(
      cards === 0
        ? 'No cards had embedded pinyin to remove.'
        : `Removed embedded pinyin from ${cards} card(s) in ${files} file(s).`,
    );
    // The readings just left the cards; the ledger is where they come from now.
    if (cards > 0) await this.runCharacterSync();
    return {files, cards};
  }

  /**
   * "I left the plugin": the practice tab staying OPEN but no longer being
   * looked at is invisible to the view's own open/close logs — switching to
   * another tab, collapsing to a sidebar or moving Obsidian to the background
   * all end a practice session in every sense except the leaf's. This tracks
   * that, so a report reads "graded a card, left for 4 minutes, came back".
   */
  private registerPracticeFocusLogging() {
    let inPracticeView = false;
    let leftAt: number | null = null;
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', leaf => {
        const nowInView = leaf?.view?.getViewType() === HANZI_VIEW_TYPE;
        if (nowInView === inPracticeView) return;
        inPracticeView = nowInView;
        if (nowInView) {
          LogInfo('User action: returned to the practice view', {
            awaySeconds:
              leftAt === null
                ? undefined
                : Math.round((Date.now() - leftAt) / 1000),
          });
          leftAt = null;
          return;
        }
        leftAt = Date.now();
        LogInfo('User action: left the practice view (switched away)', {
          switchedTo: leaf?.view?.getViewType() ?? 'none',
        });
      }),
    );
    // Obsidian itself losing focus (alt-tab, phone locked): the practice tab
    // is still the active leaf, so the event above never fires.
    this.registerDomEvent(window, 'blur', () => {
      if (!inPracticeView) return;
      LogInfo('User action: left the practice view (window lost focus)');
    });
    this.registerDomEvent(window, 'focus', () => {
      if (!inPracticeView) return;
      LogInfo('User action: returned to the practice view (window focused)');
    });
  }

  onunload() {
    LogInfo('Plugin unloading');
    const telemetry = GetTelemetry();
    // Close this run's session group so the collector never keeps a ghost
    // group open for a plugin that is gone.
    if (telemetry.some) telemetry.safeValue().end();
    ResetMetrics();
    ResetTelemetry();
    this.app.workspace.detachLeavesOfType(HANZI_VIEW_TYPE);
  }

  async loadSettings() {
    const data = await this.loadData();
    const result = SETTINGS_SCHEMA.updateSchema(data);
    if (result.ok) {
      this.settings = result.val;
    } else {
      // Telemetry is the logging path now; the console is only the failsafe
      // inside LogError when no collector is reachable.
      LogError('Failed to parse settings, using defaults', result.val);
      const defRes = SETTINGS_SCHEMA.getDefault();
      this.settings = defRes.ok
        ? defRes.val
        : {
            version: 3,
            historyFilePath: 'history.md',
            practiceFilePath: 'practice.md',
            banks: [],
            dataPacks: [],
            characterFilePath: DEFAULT_CHARACTER_FILE,
          };
    }
  }
}
