import {Plugin, WorkspaceLeaf} from 'obsidian';
import {
  HanziPluginSettings,
  HanziSettingTab,
  SETTINGS_SCHEMA,
} from './settings';
import {HanziPracticeView} from './views/hanzi_view';
import {AddCharacterModal} from './commands/add_character_modal';
import {EditBankModal} from './commands/edit_bank_modal';
import {CedictParser} from './dictionary/cedict_parser';
import {StrokeDataReader} from './data/stroke_codec';
import {loadStrokeData} from './data/stroke_data';
import {Ok, Result} from 'standard-ts-lib/src/result';
import {StatusError} from 'standard-ts-lib/src/status_error';

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

  /**
   * Lazily load + parse the CEDICT dictionary, caching it for the plugin's
   * lifetime so repeated "add character" actions don't re-parse ~10MB each time.
   */
  async getDictionary(): Promise<Result<CedictParser, StatusError>> {
    if (this.dictionary) return Ok(this.dictionary);
    const parser = new CedictParser();
    const dictPath = this.manifest.dir
      ? `${this.manifest.dir}/${CEDICT_FILE}`
      : CEDICT_FILE;
    const res = await parser.loadDictionary(this.app, dictPath);
    if (!res.ok) return res as unknown as Result<CedictParser, StatusError>;
    this.dictionary = parser;
    return Ok(parser);
  }

  /** Lazily load the stroke database, cached for the plugin's lifetime. */
  async getStrokeData(): Promise<Result<StrokeDataReader, StatusError>> {
    if (this.strokeData) return Ok(this.strokeData);
    const dataPath = this.manifest.dir
      ? `${this.manifest.dir}/${STROKES_FILE}`
      : STROKES_FILE;
    const res = await loadStrokeData(this.app, dataPath);
    if (!res.ok) return res;
    this.strokeData = res.val;
    return Ok(this.strokeData);
  }

  async onload() {
    await this.loadSettings();

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

    this.addCommand({
      id: 'open-hanzi-practice',
      name: 'Open Hanzi Practice View',
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: 'add-hanzi-character',
      name: 'Add Hanzi Character to Practice',
      callback: () => {
        new AddCharacterModal(this.app, this).open();
      },
    });

    this.addCommand({
      id: 'edit-hanzi-bank',
      name: 'Edit Hanzi Practice Bank',
      callback: () => {
        new EditBankModal(this.app, this).open();
      },
    });
  }

  async activateView() {
    const {workspace} = this.app;

    // Reuse an existing practice tab if one is already open.
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(HANZI_VIEW_TYPE)[0] ?? null;

    if (!leaf) {
      // getLeaf('tab') opens a new tab in the main (center) editor area,
      // never in the left/right sidebars.
      leaf = workspace.getLeaf('tab');
      await leaf.setViewState({type: HANZI_VIEW_TYPE, active: true});
    }

    await workspace.revealLeaf(leaf);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(HANZI_VIEW_TYPE);
  }

  async loadSettings() {
    const data = await this.loadData();
    const result = SETTINGS_SCHEMA.updateSchema(data);
    if (result.ok) {
      this.settings = result.val;
    } else {
      console.error('Failed to parse settings, using default', result.val);
      const defRes = SETTINGS_SCHEMA.getDefault();
      this.settings = defRes.ok
        ? defRes.val
        : {
            version: 0,
            historyFilePath: 'history.md',
            practiceFilePath: 'practice.md',
          };
    }
  }
}
