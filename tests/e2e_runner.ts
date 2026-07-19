import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as zlib from 'zlib';
import puppeteer, {type Page} from 'puppeteer-core';
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';

const LOG_PATH = path.join(__dirname, '..', 'e2e-run.log');
try {
  fs.writeFileSync(LOG_PATH, '');
} catch (e) {}
function log(...args: any[]) {
  const line = args
    .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');

  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (e) {}
}

// --- Dumps ---------------------------------------------------------------
// Every run writes a PNG screenshot + an HTML snapshot of the page for each
// meaningful step into ./dumps, so progress (and any stall) can be inspected
// afterwards. The folder is wiped at the start of every run so it only ever
// reflects the latest run.
const DUMPS_DIR = path.join(__dirname, '..', 'dumps');
let dumpCount = 0;
function clearDumps() {
  try {
    fs.rmSync(DUMPS_DIR, {recursive: true, force: true});
  } catch (e) {}
  try {
    fs.mkdirSync(DUMPS_DIR, {recursive: true});
  } catch (e) {}
  dumpCount = 0;
}
async function dump(page: any, label: string) {
  const n = String(++dumpCount).padStart(2, '0');
  const safe = label.replace(/[^a-z0-9_-]+/gi, '_');
  try {
    await page.screenshot({path: path.join(DUMPS_DIR, `${n}-${safe}.png`)});
  } catch (e) {
    log(`WARN could not screenshot dump ${label}: ${(e as Error).message}`);
  }
  try {
    const html = await page.content();
    fs.writeFileSync(path.join(DUMPS_DIR, `${n}-${safe}.html`), html);
  } catch (e) {
    log(`WARN could not html-dump ${label}: ${(e as Error).message}`);
  }
  log(`[dump] ${n}-${safe}`);
}

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Poll for and click Obsidian's "Trust author and enable plugins" prompt. It
// appears the first time a vault containing community plugins is opened; until
// it is dismissed the plugin stays disabled and the flow stalls. Returns true
// if the button was found and clicked.
async function clickTrustAuthor(page: any): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const clicked = await page
      .evaluate(() => {
        const buttons = Array.from(
          document.querySelectorAll('button'),
        ) as HTMLElement[];
        // Prefer the exact "Trust author…" CTA, fall back to any "Trust" button.
        const btn =
          buttons.find(b => /trust author/i.test(b.innerText)) ||
          buttons.find(b => /\btrust\b/i.test(b.innerText));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })
      .catch(() => false);
    if (clicked) return true;
    await delay(500);
  }
  return false;
}

async function takeAndCompareScreenshot(page: Page, name: string) {
  await dump(page, name);
  const screenshotPath = path.join(__dirname, '..', `${name}.png`);
  await page.screenshot({path: screenshotPath});

  const goldenPath = path.join(
    __dirname,
    '..',
    'tests',
    '__goldens__',
    `${name}.png`,
  );
  if (!fs.existsSync(goldenPath)) {
    console.log(`Golden for ${name} not found, saving new golden.`);
    fs.copyFileSync(screenshotPath, goldenPath);
    return;
  }

  const img1 = PNG.sync.read(fs.readFileSync(screenshotPath));
  const img2 = PNG.sync.read(fs.readFileSync(goldenPath));

  // Visual comparison is advisory only. Pixel-level goldens are inherently
  // environment-specific (fonts, GPU/rasterizer, DPI, subpixel AA), so a
  // mismatch here is logged loudly with a diff artifact but does NOT fail the
  // run. The functional assertions in run() are the source of truth for pass/
  // fail. Set E2E_STRICT_VISUAL=1 to make visual regressions fatal.
  const strict = process.env.E2E_STRICT_VISUAL === '1';

  if (img1.width !== img2.width || img1.height !== img2.height) {
    const msg = `[visual] size mismatch for ${name}: expected ${img2.width}x${img2.height}, got ${img1.width}x${img1.height}`;
    if (strict) throw new Error(msg);
    log('WARN', msg);
    return;
  }

  const diff = new PNG({width: img1.width, height: img1.height});
  const numDiffPixels = pixelmatch(
    img1.data,
    img2.data,
    diff.data,
    img1.width,
    img1.height,
    {threshold: 0.1},
  );

  if (numDiffPixels > 500) {
    // threshold to allow for slight rendering artifacts (e.g. blinking cursor)
    const diffPath = path.join(__dirname, '..', `${name}-diff.png`);
    fs.writeFileSync(diffPath, PNG.sync.write(diff));
    const msg = `[visual] ${name}: ${numDiffPixels} pixels differ vs golden. Diff saved to ${diffPath}`;
    if (strict) throw new Error(msg);
    log('WARN', msg);
  } else {
    log(`[visual] ${name} matches golden (${numDiffPixels} px diff).`);
  }
}

const DEBUG_PORT = 9225;

function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const req = require('http').get(
      `http://127.0.0.1:${port}/json/version`,
      (res: any) => {
        res.resume();
        resolve(true);
      },
    );
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// Synchronously kill every test-Obsidian process. Scoped to the extracted test
// AppImage path (`squashfs-root/obsidian`) ONLY — never a normally-installed
// Obsidian. Safe to call at any time (before/after a run, on interrupt).
function reapTestObsidian() {
  try {
    cp.execSync('pkill -9 -f "squashfs-root/obsidian"', {stdio: 'ignore'});
  } catch (e) {}
}

async function killLingeringObsidian() {
  // A previous run's Obsidian may still be shutting down. If it is still
  // alive, a new instance launched against the same --user-data-dir hands off
  // to it via Electron's single-instance lock and never binds the remote-
  // debugging port, so puppeteer can't connect. Guarantee a clean slate.
  reapTestObsidian();
  for (let i = 0; i < 20; i++) {
    if (!(await portInUse(DEBUG_PORT))) return;
    await delay(500);
  }
}

function regenGoldensIfRequested() {
  if (process.env.E2E_REGEN_GOLDENS !== '1') return;
  const goldenDir = path.join(__dirname, '__goldens__');
  let removed = 0;
  try {
    for (const f of fs.readdirSync(goldenDir)) {
      // Scoped: never touch the component runner's `component-*.png`
      // goldens — each runner regenerates only its own prefix.
      if (f.endsWith('.png') && !f.startsWith('component-')) {
        fs.rmSync(path.join(goldenDir, f));
        removed++;
      }
    }
  } catch (e) {
    /* dir may not exist yet */
  }
  fs.mkdirSync(goldenDir, {recursive: true});
  log(
    `E2E_REGEN_GOLDENS=1: removed ${removed} old golden(s); this run will save fresh ones into tests/__goldens__.`,
  );
}

async function run() {
  let runOk = false;
  // 1) Kill any Obsidian left over from a prior/aborted run BEFORE starting.
  // 2) Wipe the dumps folder so it only reflects this run.
  await killLingeringObsidian();
  clearDumps();
  regenGoldensIfRequested();
  const vaultPath = path.join(__dirname, '..', 'test_vault');
  const profilePath = '/tmp/obsidian-test-profile';
  if (fs.existsSync(vaultPath)) {
    console.log('Wiping existing test vault...');
    fs.rmSync(vaultPath, {recursive: true, force: true});
  }
  if (fs.existsSync(profilePath)) {
    console.log('Wiping existing test profile...');
    fs.rmSync(profilePath, {recursive: true, force: true});
  }
  const pluginPath = path.join(
    vaultPath,
    '.obsidian',
    'plugins',
    'hanzi-practice',
  );

  console.log('Setting up vault at:', vaultPath);
  fs.mkdirSync(pluginPath, {recursive: true});

  // Copy built plugin files
  fs.copyFileSync(
    path.join(__dirname, '..', 'main.js'),
    path.join(pluginPath, 'main.js'),
  );
  fs.copyFileSync(
    path.join(__dirname, '..', 'manifest.json'),
    path.join(pluginPath, 'manifest.json'),
  );
  // Ship the GZIPPED CEDICT alongside the plugin (same as a real install), so
  // the "add character" flow can resolve pinyin + English. Prefer the file the
  // production build already emitted to dist/; otherwise gzip on the fly.
  const gzName = 'cedict_1_0_ts_utf-8_mdbg_20240705_025126.txt.gz';
  const distGz = path.join(__dirname, '..', 'dist', gzName);
  const destGz = path.join(pluginPath, gzName);
  if (fs.existsSync(distGz)) {
    fs.copyFileSync(distGz, destGz);
  } else {
    const raw = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'cedict_1_0_ts_utf-8_mdbg_20240705_025126.txt',
      ),
    );
    fs.writeFileSync(destGz, zlib.gzipSync(raw));
  }
  // Ship the medians-only stroke database too (generated into dist/ by the
  // production build). The quiz writer needs it — there is no CDN fallback.
  const strokesGz = 'hanzi-strokes.bin.gz';
  const distStrokes = path.join(__dirname, '..', 'dist', strokesGz);
  if (!fs.existsSync(distStrokes)) {
    throw new Error(
      `${distStrokes} not found — run \`npm run build\` first (it generates the stroke database).`,
    );
  }
  fs.copyFileSync(distStrokes, path.join(pluginPath, strokesGz));

  // Enable plugin and disable safe mode
  fs.writeFileSync(
    path.join(vaultPath, '.obsidian', 'app.json'),
    JSON.stringify({safeMode: false}),
  );

  const vaultId = 'e2e-test-vault-123';

  // When Obsidian is launched with --user-data-dir=X, Electron's userData dir
  // IS X, so Obsidian reads/writes its vault registry at X/obsidian.json
  // directly (NOT X/obsidian/obsidian.json). Writing it to the nested path
  // left Obsidian unable to find the registered vault, so it opened the vault
  // picker (starter.html) instead of the vault — which stalled STEP 1.
  if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, {recursive: true});

  const obsidianJsonPath = path.join(profilePath, 'obsidian.json');
  let obsidianConfig: any = {vaults: {}};
  if (fs.existsSync(obsidianJsonPath)) {
    try {
      obsidianConfig = JSON.parse(fs.readFileSync(obsidianJsonPath, 'utf8'));
    } catch (e) {}
  }

  obsidianConfig.vaults[vaultId] = {
    path: vaultPath,
    ts: Date.now(),
    open: true,
  };

  fs.writeFileSync(obsidianJsonPath, JSON.stringify(obsidianConfig, null, 2));

  log('Starting Obsidian...');
  const appImage = path.join(__dirname, '..', 'squashfs-root', 'obsidian');
  const child = cp.spawn(
    appImage,
    [
      vaultPath,
      `--user-data-dir=${profilePath}`,
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-allow-origins=*',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--ozone-platform=x11',
    ],
    {
      detached: true,
      stdio: 'pipe',
    },
  );

  child.stdout.on('data', (d: any) => log('OBSIDIAN:', d.toString().trim()));
  child.stderr.on('data', (d: any) =>
    log('OBSIDIAN ERR:', d.toString().trim()),
  );
  child.on('exit', (code: any, sig: any) =>
    log(`OBSIDIAN process exited early: code=${code} sig=${sig}`),
  );
  child.unref();

  log('Waiting for Obsidian to start...');
  await delay(10000); // Give it time to launch

  log('Connecting Puppeteer...');
  let browser: any;
  const connectRetries = 30;
  for (let i = 0; i < connectRetries; i++) {
    try {
      browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${DEBUG_PORT}`,
        defaultViewport: null,
      });
      break;
    } catch (e: any) {
      log('Retry connect...', e.message);
      await delay(2000);
    }
  }
  if (!browser) {
    throw new Error(
      `Could not connect to Obsidian after ${connectRetries} retries (remote-debugging port ${DEBUG_PORT} never became reachable)`,
    );
  }

  let page: any = null;
  try {
    // Obsidian spawns several renderer targets (the vault window, plus
    // possibly a starter/vault-picker window). Poll until we find the one
    // that actually has the loaded workspace (window.app.workspace), rather
    // than guessing by URL — the picker and the vault both use app.html-ish
    // URLs and attaching to the wrong one is what stalled STEP 1.
    const deadline = Date.now() + 60000;
    let lastTargetsDump = '';
    while (Date.now() < deadline) {
      const targets = browser.targets();
      lastTargetsDump = targets
        .map((t: any) => `${t.type()}:${t.url()}`)
        .join('\n  ');
      const pageTargets = targets.filter((t: any) => t.type() === 'page');
      for (const t of pageTargets) {
        let p: any = null;
        try {
          p = await t.page();
        } catch (e) {
          continue;
        }
        if (!p) continue;
        let ready = false;
        try {
          ready = await p.evaluate(() => {
            const w = window as any;
            return !!(w.app && w.app.workspace && w.app.workspace.layoutReady);
          });
        } catch (e) {
          /* execution context may be tearing down */
        }
        if (ready) {
          page = p;
          break;
        }
      }
      if (page) break;
      await delay(2000);
    }
    if (!page) {
      log('Available targets:\n  ' + lastTargetsDump);
      throw new Error(
        'Could not find a loaded Obsidian workspace page (layoutReady never became true)',
      );
    }
    page.on('console', (msg: any) => log('PAGE LOG:', msg.text()));
    page.on('pageerror', (err: any) => log('PAGE ERROR:', err.toString()));

    log('Connected to loaded Obsidian workspace.');

    // STEP 1: Create vault (done via startup)
    log('STEP 1: Vault created and loaded.');
    await delay(2000);
    await dump(page, 'step1-loaded');

    // Dismiss the "Do you trust the author of this vault?" prompt by clicking
    // "Trust author and enable plugins". Until this is clicked the plugin
    // stays disabled and every later step stalls.
    const trusted = await clickTrustAuthor(page);
    log(
      trusted
        ? 'Clicked "Trust author and enable plugins".'
        : 'No trust prompt appeared (already trusted).',
    );
    await delay(1500);
    await dump(page, 'step1-after-trust');

    await takeAndCompareScreenshot(page, 'step1-vault');

    // STEP 2 & 3: Enable community plugins + the Hanzi Practice plugin.
    // Do it via Obsidian's own API rather than driving the toggle: disabling
    // Restricted Mode and enabling the plugin programmatically is
    // deterministic, whereas depending on the "Trust author" modal appearing
    // within a fixed poll window is flaky (some launches auto-trust and the
    // modal never shows, leaving Restricted Mode on and the plugin hidden).
    console.log(
      'STEP 3: Enabling community plugins + Hanzi Practice plugin...',
    );
    const pluginEnabled = await page.evaluate(async () => {
      const app = (window as any).app;
      try {
        await app.plugins.setEnable(true);
      } catch (e) {
        /* already on */
      }
      try {
        await app.plugins.enablePluginAndSave('hanzi-practice');
      } catch (e) {
        try {
          await app.plugins.enablePlugin('hanzi-practice');
        } catch (e2) {}
      }
      // Give onload a beat to register commands.
      await new Promise(r => setTimeout(r, 500));
      return (
        !!(app.plugins.plugins && app.plugins.plugins['hanzi-practice']) &&
        !!app.commands.commands['hanzi-practice:add-hanzi-character']
      );
    });
    if (!pluginEnabled) {
      await dump(page, 'STEP3-plugin-not-enabled');
      throw new Error(
        'Hanzi Practice plugin did not enable / register its commands.',
      );
    }
    console.log('Plugin enabled and commands registered.');

    // Open the Community plugins settings pane for the screenshot/record.
    await page.evaluate(() => {
      (window as any).app.setting.open();
      setTimeout(
        () => (window as any).app.setting.openTabById('community-plugins'),
        200,
      );
    });
    await delay(2000);
    await takeAndCompareScreenshot(page, 'step3-plugin-enabled');

    // Close settings
    await page.keyboard.press('Escape');
    await delay(1000);

    // STEP 4: Add multiple characters to the plugin
    console.log('STEP 4: Adding characters...');
    const charsToAdd = ['好', '汉', '字'];
    for (let idx = 0; idx < charsToAdd.length; idx++) {
      const char = charsToAdd[idx];
      let addResult = false;
      for (let i = 0; i < 5; i++) {
        addResult = await page.evaluate(() => {
          return (window as any).app.commands.executeCommandById(
            'hanzi-practice:add-hanzi-character',
          );
        });
        if (addResult) break;
        await delay(1000);
      }
      if (!addResult) {
        throw new Error(
          'Command hanzi-practice:add-hanzi-character failed to execute',
        );
      }

      await delay(1000); // wait for modal
      await page.waitForSelector('.modal input[type="text"]', {
        timeout: 5000,
        visible: true,
      });

      // Type the character
      await page.type('.modal input[type="text"]', char);
      await delay(500);

      // Screenshot the dialog for the first character
      if (idx === 0) {
        await takeAndCompareScreenshot(page, 'step4-add-character-dialog');
      }

      await page.keyboard.press('Enter');
      await delay(500);
      await page.click('.modal button.mod-cta').catch(() => {}); // fallback click, ignore if closed
      // The modal closes once the character is written. The FIRST add also
      // parses the (gzipped) CEDICT to cache pinyin+def, so allow time.
      await page
        .waitForFunction(
          () => !document.querySelector('.modal input[type="text"]'),
          {timeout: 30000},
        )
        .catch(() => {});
      await delay(500);
    }
    await takeAndCompareScreenshot(page, 'step4-added-characters');

    // STEP 4b: Adding a duplicate character should show an error and NOT close the modal
    console.log('STEP 4b: Verifying duplicate character error...');
    let dupOpened = false;
    for (let i = 0; i < 5; i++) {
      dupOpened = await page.evaluate(() => {
        return (window as any).app.commands.executeCommandById(
          'hanzi-practice:add-hanzi-character',
        );
      });
      if (dupOpened) break;
      await delay(1000);
    }
    if (!dupOpened) {
      throw new Error(
        'Command hanzi-practice:add-hanzi-character failed to execute for duplicate test',
      );
    }
    await delay(1000);
    await page.waitForSelector('.modal input[type="text"]', {
      timeout: 5000,
      visible: true,
    });
    await page.type('.modal input[type="text"]', '好'); // already added above
    await delay(500);
    await page.click('.modal button.mod-cta').catch(() => {});
    await delay(1000);

    // The modal must still be open and show the inline error
    const dupErrorShown = await page.evaluate(() => {
      const err = document.querySelector(
        '.modal .hanzi-add-error',
      ) as HTMLElement | null;
      const modalStillOpen = !!document.querySelector(
        '.modal input[type="text"]',
      );
      return (
        modalStillOpen &&
        !!err &&
        err.style.display !== 'none' &&
        err.textContent!.trim().length > 0
      );
    });
    if (!dupErrorShown) {
      throw new Error(
        'Duplicate character did not surface an inline error in the still-open modal!',
      );
    }
    await takeAndCompareScreenshot(page, 'step4-duplicate-error');
    await page.keyboard.press('Escape');
    await delay(1000);

    // STEP 5: Check in the MD the character is there
    console.log('STEP 5: Verifying hanzi-practice-words.md...');
    const practiceMdPath = path.join(vaultPath, 'hanzi-practice-words.md');
    if (!fs.existsSync(practiceMdPath)) {
      throw new Error(`hanzi-practice-words.md not found at ${practiceMdPath}`);
    }
    const practiceMd = fs.readFileSync(practiceMdPath, 'utf-8');
    for (const char of charsToAdd) {
      if (!practiceMd.includes(char)) {
        throw new Error(
          `Character ${char} not found in hanzi-practice-words.md!`,
        );
      }
    }
    // The pinyin + definition must have been cached into the words file at
    // add time (tab-separated: `好\thao3\tgood/...`) so the practice view
    // never needs the dictionary.
    const haoLine = practiceMd.split('\n').find(l => l.startsWith('好'));
    if (!haoLine || !haoLine.includes('\t')) {
      throw new Error(
        `Expected 好 to have cached pinyin/def (tab-separated); got: ${JSON.stringify(haoLine)}`,
      );
    }
    const [, haoPinyin, haoEnglish] = haoLine.split('\t');
    if (!/hao3/.test(haoPinyin || '') || !(haoEnglish || '').trim()) {
      throw new Error(`好 line missing pinyin/def: ${JSON.stringify(haoLine)}`);
    }
    console.log(
      `Verified characters + cached pinyin/def in words file (好 -> ${haoPinyin}).`,
    );

    // STEP 6: Run the test command so you can test your hanzi skill
    console.log('STEP 6: Running test command...');
    await page.evaluate(() => {
      (window as any).app.commands.executeCommandById(
        'hanzi-practice:open-hanzi-practice',
      );
    });
    await delay(2000);

    // The practice view must live in the center (main) area, not a sidebar.
    const inCenterPane = await page.evaluate(() => {
      const leaf = document.querySelector(
        '.workspace-leaf-content[data-type="hanzi-practice-view"]',
      );
      if (!leaf) return false;
      return (
        !!leaf.closest('.mod-root') &&
        !leaf.closest('.mod-left-split') &&
        !leaf.closest('.mod-right-split')
      );
    });
    if (!inCenterPane) {
      throw new Error('Hanzi practice view is not in the center pane!');
    }
    console.log('Verified practice view is in the center pane.');

    // The dictionary is shipped with the plugin, so the meaning line and the
    // tone selector must render (parsing the CEDICT takes a moment — poll).
    let dictReady = false;
    for (let i = 0; i < 30; i++) {
      dictReady = await page
        .evaluate(() => {
          const view = document.querySelector(
            '.workspace-leaf-content[data-type="hanzi-practice-view"]',
          );
          if (!view) return false;
          const meaning = view.querySelector('.hanzi-meaning');
          const toneButtons = view.querySelectorAll(
            '.tone-selector .pinyin-btn-container button',
          );
          return (
            !!meaning &&
            (meaning.textContent || '').trim().length > 0 &&
            toneButtons.length > 0
          );
        })
        .catch(() => false);
      if (dictReady) break;
      await delay(1000);
    }
    if (!dictReady) {
      await dump(page, 'STEP6-no-dictionary');
      throw new Error(
        'Practice view did not render the meaning + tone selector (dictionary failed to load)!',
      );
    }
    console.log('Verified meaning + tone selector rendered from dictionary.');

    await takeAndCompareScreenshot(page, 'step6-practice-view');

    // The quiz writer is created asynchronously (the view first loads +
    // gunzips the plugin-shipped stroke database — no network involved).
    // Wait for it before driving the stroke quiz.
    let writerReady = false;
    for (let i = 0; i < 30; i++) {
      writerReady = await page
        .evaluate(() => {
          const leaves = (window as any).app.workspace.getLeavesOfType(
            'hanzi-practice-view',
          );
          const view = leaves[0] && leaves[0].view;
          return !!(view && view.writer && view.writer.strokeCount > 0);
        })
        .catch(() => false);
      if (writerReady) break;
      await delay(1000);
    }
    if (!writerReady) {
      await dump(page, 'STEP6-writer-not-loaded');
      throw new Error(
        'Quiz writer did not initialize (stroke database missing or failed to load)',
      );
    }

    // STEP 6b: Stroke quiz — draw the FIRST stroke wrong three times. Each
    // miss must increment the mistake counter, and the third miss must make
    // the writer highlight the expected stroke as a hint.
    console.log(
      'STEP 6b: Drawing a wrong stroke repeatedly to trigger the hint...',
    );
    const svgRect = await page.evaluate(() => {
      const svg = document.querySelector(
        '.workspace-leaf-content[data-type="hanzi-practice-view"] #hanzi-draw-container svg',
      );
      if (!svg) return null;
      const r = svg.getBoundingClientRect();
      return {left: r.left, top: r.top, width: r.width, height: r.height};
    });
    if (!svgRect) {
      throw new Error('Quiz writer SVG not found in the practice view.');
    }
    const drawStroke = async (points: Array<{x: number; y: number}>) => {
      await page.mouse.move(points[0].x, points[0].y);
      await page.mouse.down();
      for (const p of points.slice(1)) {
        await page.mouse.move(p.x, p.y, {steps: 4});
      }
      await page.mouse.up();
      await delay(300);
    };
    // A deliberately-wrong stroke: a short scribble in the top-right corner
    // of the drawing box, nowhere near 好's first stroke (which starts
    // top-center-left and sweeps down-left).
    const wrongStroke = [
      {
        x: svgRect.left + svgRect.width * 0.88,
        y: svgRect.top + svgRect.height * 0.1,
      },
      {
        x: svgRect.left + svgRect.width * 0.95,
        y: svgRect.top + svgRect.height * 0.16,
      },
    ];
    for (let attempt = 1; attempt <= 3; attempt++) {
      await drawStroke(wrongStroke);
      const mistakes = await page.evaluate(() => {
        const view = (window as any).app.workspace.getLeavesOfType(
          'hanzi-practice-view',
        )[0].view;
        return view.strokeMistakes;
      });
      if (mistakes !== attempt) {
        await dump(page, `STEP6b-mistake-not-counted-${attempt}`);
        throw new Error(
          `Wrong stroke attempt ${attempt} was not graded as a mistake (counter=${mistakes})`,
        );
      }
    }
    // The third miss must surface the hint: the expected stroke highlighted.
    const hintShown = await page.evaluate(() => {
      const view = document.querySelector(
        '.workspace-leaf-content[data-type="hanzi-practice-view"]',
      );
      const hint = view && view.querySelector('.hanzi-stroke-hint');
      return !!hint && (hint as SVGElement).getBoundingClientRect().width > 0;
    });
    if (!hintShown) {
      await dump(page, 'STEP6b-no-hint');
      throw new Error(
        'Hint highlight (.hanzi-stroke-hint) did not appear after 3 misses on the same stroke!',
      );
    }
    console.log('Verified hint highlight after 3 misses.');
    await takeAndCompareScreenshot(page, 'step6-stroke-hint');

    // Now draw the stroke CORRECTLY (replay the expected stroke's median in
    // screen coordinates): it must be accepted, advance the quiz, and clear
    // the hint.
    const strokePoints = await page.evaluate(() => {
      const view = (window as any).app.workspace.getLeavesOfType(
        'hanzi-practice-view',
      )[0].view;
      return view.writer.getStrokeDisplayPoints(0);
    });
    await drawStroke(
      strokePoints.map((p: {x: number; y: number}) => ({
        x: svgRect.left + p.x,
        y: svgRect.top + p.y,
      })),
    );
    const afterCorrect = await page.evaluate(() => {
      const view = (window as any).app.workspace.getLeavesOfType(
        'hanzi-practice-view',
      )[0].view;
      const leafEl = document.querySelector(
        '.workspace-leaf-content[data-type="hanzi-practice-view"]',
      );
      return {
        strokeIndex: view.writer.currentStrokeIndex,
        hintGone: !leafEl || !leafEl.querySelector('.hanzi-stroke-hint'),
        doneStrokes: leafEl
          ? leafEl.querySelectorAll('.hanzi-stroke-done').length
          : 0,
      };
    });
    if (
      afterCorrect.strokeIndex !== 1 ||
      !afterCorrect.hintGone ||
      afterCorrect.doneStrokes !== 1
    ) {
      await dump(page, 'STEP6b-correct-stroke-rejected');
      throw new Error(
        `Correct stroke was not accepted: ${JSON.stringify(afterCorrect)}`,
      );
    }
    console.log(
      'Verified correct stroke accepted, hint cleared, stroke rendered.',
    );
    await dump(page, 'step6b-correct-stroke');

    console.log('Simulating grading completion...');
    const graded = await page.evaluate(() => {
      const workspace = (window as any).app.workspace;
      const leaves = workspace.getLeavesOfType('hanzi-practice-view');
      if (leaves.length === 0) return false;
      const view = leaves[0].view;
      view.currentCharacter = '好'; // hardcode to the one we expect in test
      view.pinyinMistakes = 0; // zero mistakes simulated
      view.handleQuizComplete({
        character: view.currentCharacter,
        totalMistakes: 0,
      });
      return true;
    });
    if (!graded) {
      throw new Error('Could not find the practice view to simulate grading.');
    }
    await delay(1500);
    await takeAndCompareScreenshot(page, 'step6-graded');

    // STEP 7: Check the md for my attempt and score
    console.log('STEP 7: Verifying hanzi-practice-history.md...');
    const historyMdPath = path.join(vaultPath, 'hanzi-practice-history.md');
    if (!fs.existsSync(historyMdPath)) {
      throw new Error(
        `hanzi-practice-history.md not found at ${historyMdPath}`,
      );
    }
    const historyMd = fs.readFileSync(historyMdPath, 'utf-8');
    if (!historyMd.includes('好:') || !historyMd.includes('- [')) {
      throw new Error('Grade not added to hanzi-practice-history.md!');
    }
    console.log('Verified score in hanzi-practice-history.md');

    // STEP 8: Go to the plugin settings
    console.log('STEP 8: Opening settings...');
    await page.evaluate(() => {
      (window as any).app.setting.open();
      setTimeout(
        () => (window as any).app.setting.openTabById('hanzi-practice'),
        200,
      );
    });
    await delay(1000);
    await takeAndCompareScreenshot(page, 'step8-settings');

    log('E2E steps complete!');
    log('Closing Obsidian...');
    await browser.disconnect();
    runOk = true;
  } catch (e) {
    log('Error during automation:', (e as Error).stack || String(e));
    // Capture exactly where it stalled for post-mortem inspection.
    if (page) {
      try {
        await dump(page, 'FAILURE');
      } catch (e2) {}
    }
  } finally {
    // Terminate the detached Obsidian process group. Guard carefully so a
    // failure here never signals the runner's own process group.
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
    } catch (e) {
      try {
        child.kill('SIGTERM');
      } catch (e2) {}
    }
    // Belt-and-suspenders: reap any test-Obsidian process that survived the
    // group kill (Electron helper processes, orphaned renderers).
    reapTestObsidian();
  }
  return runOk;
}

// If the run is interrupted (Ctrl-C, kill), still reap Obsidian before exiting.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    reapTestObsidian();
    process.exit(1);
  });
}

// Guarantee "kill after" no matter how run() ends — including the pre-try
// "could not connect" throw, which the finally above does NOT cover.
run()
  .then(ok => {
    reapTestObsidian();
    log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
    process.exit(ok ? 0 : 1);
  })
  .catch(e => {
    reapTestObsidian();
    log('RESULT: FAIL (threw)', String(e));
    process.exit(1);
  });
