import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as zlib from 'zlib';
import puppeteer, {type Page} from 'puppeteer-core';
import {PNG} from 'pngjs';
import pixelmatch from 'pixelmatch';
import {
  computeClozeId,
  computeFlashcardId,
  computeMultiChoiceId,
} from '../src/utils/practice_list';

// --- Mobile emulation ----------------------------------------------------
// E2E_EMULATE_MOBILE=1 runs the whole flow with Obsidian's built-in mobile
// emulation (app.emulateMobile(true), per
// https://docs.obsidian.md/Plugins/Getting+started/Mobile+development), so the
// plugin loads and renders under the mobile UI/layout. Goldens get a `mobile-`
// prefix so they never collide with the desktop ones.
//
// Note: emulateMobile also faithfully simulates Capacitor's missing Node.js —
// Obsidian's wrapRequire rejects plugin require()s of Node builtins with
// `[<plugin-id>] Attempting to load NodeJS package: "zlib"`, so a bundle that
// depends on Node APIs fails under this mode just like on a real device.
const EMULATE_MOBILE = process.env.E2E_EMULATE_MOBILE === '1';
const GOLDEN_PREFIX = EMULATE_MOBILE ? 'mobile-' : '';

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

async function takeAndCompareScreenshot(page: Page, rawName: string) {
  const name = GOLDEN_PREFIX + rawName;
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
      // goldens — each runner regenerates only its own prefix. The mobile and
      // desktop E2E variants likewise only regenerate their own goldens.
      if (!f.endsWith('.png') || f.startsWith('component-')) continue;
      const isMobileGolden = f.startsWith('mobile-');
      if (isMobileGolden !== EMULATE_MOBILE) continue;
      fs.rmSync(path.join(goldenDir, f));
      removed++;
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
    // Wipe CONTENTS rather than the directory: under docker the vault dir is
    // a bind mount (exposed on the host as docker-artifacts/desktop_vault or
    // mobile_vault for post-run inspection), and a mount point itself cannot
    // be removed (EBUSY).
    for (const name of fs.readdirSync(vaultPath)) {
      fs.rmSync(path.join(vaultPath, name), {recursive: true, force: true});
    }
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
  // Ship the stroke database (medians + outlines) too (generated into dist/ by the
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

  // Obsidian spawns several renderer targets (the vault window, plus
  // possibly a starter/vault-picker window). Poll until we find the one
  // that actually has the loaded workspace (window.app.workspace), rather
  // than guessing by URL — the picker and the vault both use app.html-ish
  // URLs and attaching to the wrong one is what stalled STEP 1.
  const findWorkspacePage = async (timeoutMs: number): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
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
        if (ready) return p;
      }
      await delay(2000);
    }
    log('Available targets:\n  ' + lastTargetsDump);
    return null;
  };
  const attachPageLogs = (p: any) => {
    p.on('console', async (msg: any) => {
      let text = msg.text();
      // Error objects print as an opaque "JSHandle@error" — deserialize them
      // so the actual message/stack lands in the log.
      if (text.includes('JSHandle@')) {
        try {
          const parts = await Promise.all(
            msg
              .args()
              .map((a: any) =>
                a.evaluate((v: any) =>
                  v instanceof Error ? v.stack || v.message : String(v),
                ),
              ),
          );
          text = parts.join(' ');
        } catch (e) {
          /* page may have navigated away */
        }
      }
      log('PAGE LOG:', text);
    });
    p.on('pageerror', (err: any) => log('PAGE ERROR:', err.toString()));
  };

  let page: any = null;
  try {
    page = await findWorkspacePage(60000);
    if (!page) {
      throw new Error(
        'Could not find a loaded Obsidian workspace page (layoutReady never became true)',
      );
    }
    attachPageLogs(page);

    log('Connected to loaded Obsidian workspace.');

    if (EMULATE_MOBILE) {
      // Shrink the window to a phone-ish size first so Obsidian's emulation
      // picks the phone layout (is-phone) rather than tablet. Best-effort —
      // if the CDP Browser domain isn't available we still emulate at the
      // current window size (which Obsidian then treats as a tablet).
      log('MOBILE: resizing window to phone form factor (best-effort)...');
      try {
        const session = await page.target().createCDPSession();
        const {windowId} = await session.send('Browser.getWindowForTarget');
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: {width: 420, height: 860},
        });
        await session.detach();
      } catch (e) {
        log('WARN could not resize window via CDP:', (e as Error).message);
      }
      await delay(1000);
      log('MOBILE: enabling Obsidian mobile emulation (app.emulateMobile)...');
      await page
        .evaluate(() => {
          (window as any).app.emulateMobile(true);
        })
        .catch((e: Error) => log('MOBILE: emulateMobile call:', e.message));
      // emulateMobile may apply live, or persist a flag that only takes
      // effect after a window reload (which it may or may not trigger
      // itself). Poll for the mobile UI; if the execution context dies the
      // window reloaded — reattach. If nothing happened after ~10s, force a
      // reload once so a persisted flag gets picked up.
      let mobileOn = false;
      let forcedReload = false;
      const mobDeadline = Date.now() + 45000;
      while (Date.now() < mobDeadline) {
        let state: any = null;
        try {
          state = await page.evaluate(() => {
            const w = window as any;
            return {
              isMobile: !!(w.app && w.app.isMobile),
              layoutReady: !!(
                w.app &&
                w.app.workspace &&
                w.app.workspace.layoutReady
              ),
              classes: document.body.className
                .split(/\s+/)
                .filter(c => /mobile|phone|tablet/i.test(c)),
            };
          });
        } catch (e) {
          log('MOBILE: window reloaded; re-acquiring workspace page...');
          const p = await findWorkspacePage(30000);
          if (p && p !== page) {
            page = p;
            attachPageLogs(page);
          }
          continue;
        }
        if (state && state.isMobile && state.layoutReady) {
          log('MOBILE: emulation active:', JSON.stringify(state));
          mobileOn = true;
          break;
        }
        if (!forcedReload && Date.now() > mobDeadline - 35000) {
          forcedReload = true;
          log('MOBILE: no live effect — forcing a window reload...');
          await page.evaluate(() => window.location.reload()).catch(() => {});
          await delay(3000);
          continue;
        }
        await delay(1000);
      }
      if (!mobileOn) {
        const diag = await page
          .evaluate(() => {
            const w = window as any;
            const lsKeys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i) || '';
              if (/mobile|emulate/i.test(k)) {
                lsKeys.push(`${k}=${localStorage.getItem(k)}`);
              }
            }
            return {
              typeofEmulate: typeof (w.app && w.app.emulateMobile),
              isMobile: w.app && w.app.isMobile,
              appId: w.app && w.app.appId,
              lsKeys,
              bodyClasses: document.body.className,
            };
          })
          .catch(() => null);
        log('MOBILE: diagnostics:', JSON.stringify(diag));
        await dump(page, 'MOBILE-emulation-failed');
        throw new Error(
          'app.emulateMobile(true) did not activate mobile mode (see diagnostics above)',
        );
      }
      await delay(1500);
      await dump(page, 'step0-mobile-emulated');
    }

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

    // Close settings (Escape on desktop; the mobile UI uses a close button)
    await page.keyboard.press('Escape');
    await page.click('.modal-close-button').catch(() => {});
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

      // The Add button must be greyed out until a definition is selected.
      const disabledBeforeSelect = await page.evaluate(() => {
        const btn = document.querySelector(
          '.modal button.mod-cta',
        ) as HTMLButtonElement | null;
        return !!btn && btn.disabled;
      });
      if (!disabledBeforeSelect) {
        throw new Error(
          'Add button was not disabled before selecting a definition!',
        );
      }

      // Typing triggers the definition lookup. The FIRST lookup also parses
      // the (gzipped) CEDICT, so allow generous time for options to render.
      await page.waitForSelector('.modal .hanzi-def-option', {
        timeout: 60000,
        visible: true,
      });

      if (idx === 0) {
        // 好 has multiple CEDICT senses (hao3 "good", hao4 "to be fond of") —
        // each must surface as its own selectable option.
        const optionCount = await page.evaluate(
          () => document.querySelectorAll('.modal .hanzi-def-option').length,
        );
        if (optionCount < 2) {
          throw new Error(
            `Expected multiple definition options for 好; got ${optionCount}`,
          );
        }
        // Screenshot the dialog (with its option list) for the first character
        await takeAndCompareScreenshot(page, 'step4-add-character-dialog');
      }

      // Select the first definition option; the Add button must enable.
      await page.click('.modal .hanzi-def-option');
      await delay(300);
      const enabledAfterSelect = await page.evaluate(() => {
        const btn = document.querySelector(
          '.modal button.mod-cta',
        ) as HTMLButtonElement | null;
        return !!btn && !btn.disabled;
      });
      if (!enabledAfterSelect) {
        throw new Error(
          'Add button did not enable after selecting a definition!',
        );
      }

      await page.click('.modal button.mod-cta');
      // The modal closes once the character is written.
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
    // The dup-check only runs on Add, which needs a selected definition
    // (dictionary is already parsed/cached by now, so options come up fast).
    await page.waitForSelector('.modal .hanzi-def-option', {
      timeout: 15000,
      visible: true,
    });
    await page.click('.modal .hanzi-def-option');
    await delay(300);
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
    await page.click('.modal-close-button').catch(() => {});
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
    const [, haoPinyin, haoEnglish, haoId] = haoLine.split('\t');
    if (!/hao3/.test(haoPinyin || '') || !(haoEnglish || '').trim()) {
      throw new Error(`好 line missing pinyin/def: ${JSON.stringify(haoLine)}`);
    }
    // Every entry must carry its stable id (hash of char+pinyin) as the 4th
    // field — history is keyed by it.
    if (!/^[0-9a-f]{8}$/.test(haoId || '')) {
      throw new Error(
        `好 line missing 8-hex entry id: ${JSON.stringify(haoLine)}`,
      );
    }
    console.log(
      `Verified characters + cached pinyin/def/id in words file (好 -> ${haoPinyin}, ${haoId}).`,
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
    const graded = await page.evaluate(
      (entry: {
        id: string;
        character: string;
        pinyin: string;
        english: string;
      }) => {
        const workspace = (window as any).app.workspace;
        const leaves = workspace.getLeavesOfType('hanzi-practice-view');
        if (leaves.length === 0) return false;
        const view = leaves[0].view;
        // Hardcode to the entry we expect in test (id read from the words
        // file at STEP 5) — history is keyed by the entry id.
        view.currentEntry = entry;
        view.currentCharacter = entry.character;
        view.pinyinMistakes = 0; // zero mistakes simulated
        view.handleQuizComplete({
          character: entry.character,
          totalMistakes: 0,
        });
        return true;
      },
      {
        id: haoId,
        character: '好',
        pinyin: haoPinyin,
        english: haoEnglish,
      },
    );
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
    // The line must carry the entry id (the history key) AND the
    // human-readable character + pinyin.
    if (
      !historyMd.includes('- [') ||
      !historyMd.includes(`${haoId} 好 (${haoPinyin}):`)
    ) {
      throw new Error(
        `Grade with id/char/pinyin not in hanzi-practice-history.md! Contents: ${JSON.stringify(historyMd)}`,
      );
    }
    console.log('Verified id-keyed score in hanzi-practice-history.md');

    // STEP 7b: Edit Hanzi Bank — list all entries, then remove one
    console.log('STEP 7b: Editing the hanzi bank (removing 字)...');
    let editOpened = false;
    for (let i = 0; i < 5; i++) {
      editOpened = await page.evaluate(() => {
        return (window as any).app.commands.executeCommandById(
          'hanzi-practice:edit-hanzi-bank',
        );
      });
      if (editOpened) break;
      await delay(1000);
    }
    if (!editOpened) {
      throw new Error(
        'Command hanzi-practice:edit-hanzi-bank failed to execute',
      );
    }
    await delay(1000);
    await page.waitForSelector('.modal .hanzi-bank-row', {
      timeout: 5000,
      visible: true,
    });
    const bankRows: (string | null)[] = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.modal .hanzi-bank-row')).map(
        r => r.querySelector('.hanzi-bank-char')?.textContent ?? null,
      ),
    );
    if (
      bankRows.length !== charsToAdd.length ||
      !charsToAdd.every(c => bankRows.includes(c))
    ) {
      throw new Error(
        `Edit-bank rows mismatch; expected ${JSON.stringify(charsToAdd)}, got ${JSON.stringify(bankRows)}`,
      );
    }
    await takeAndCompareScreenshot(page, 'step7b-edit-bank');

    // Remove 字, wait for the row to disappear, and verify the words file.
    const removeClicked = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('.modal .hanzi-bank-row'),
      );
      const target = rows.find(
        r => r.querySelector('.hanzi-bank-char')?.textContent === '字',
      );
      if (!target) return false;
      (target.querySelector('button.hanzi-bank-remove') as HTMLElement).click();
      return true;
    });
    if (!removeClicked) {
      throw new Error('Could not find the 字 row in the edit-bank modal!');
    }
    await page.waitForFunction(
      () => document.querySelectorAll('.modal .hanzi-bank-row').length === 2,
      {timeout: 5000},
    );
    await delay(500);
    await takeAndCompareScreenshot(page, 'step7b-edit-bank-removed');
    const wordsAfterRemove = fs.readFileSync(practiceMdPath, 'utf-8');
    if (wordsAfterRemove.includes('字')) {
      throw new Error('字 still present in the words file after removal!');
    }
    if (!wordsAfterRemove.includes('好') || !wordsAfterRemove.includes('汉')) {
      throw new Error(
        `Removal deleted the wrong entries! Contents: ${JSON.stringify(wordsAfterRemove)}`,
      );
    }
    console.log('Verified 字 removed from the bank (words file rewritten).');
    await page.keyboard.press('Escape');
    await page.click('.modal-close-button').catch(() => {});
    await delay(500);

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
    await page.keyboard.press('Escape');
    await delay(500);

    // STEP 9: Flashcards. Banks are defined in settings, each storing its
    // cards in its OWN file (like the Hanzi words file) — so first create two
    // banks through the settings UI, then add + practice a card.
    console.log(
      'STEP 9a: Creating banks via the settings Practice Banks UI...',
    );
    await page.evaluate(() => {
      (window as any).app.setting.open();
      setTimeout(
        () => (window as any).app.setting.openTabById('hanzi-practice'),
        200,
      );
    });
    // open() restores the last-open tab (ours, from STEP 8) and renders it
    // immediately; the queued openTabById renders it AGAIN at ~200ms. Wait
    // out both renders before interacting, or the second one rebuilds the
    // pane mid-typing and the keystrokes land on a detached input.
    await delay(800);
    await page.waitForSelector('.hanzi-bank-add', {timeout: 10000});
    // Sets a bank text field by dispatching an `input` event on the LIVE
    // element (queried at dispatch time) — Obsidian's TextComponent onChange
    // listens to `input`, and this can't miss like focus-dependent typing
    // can when a re-render swaps the element out. Banks render as a LIST
    // (one row per bank); "Add Bank" appends a row, so the LAST match is
    // always the newest bank's field.
    const setBankField = async (selector: string, value: string) => {
      await page.waitForSelector(selector, {timeout: 10000});
      await page.evaluate(
        (sel: string, v: string) => {
          const els = document.querySelectorAll(sel);
          const el = els[els.length - 1] as HTMLInputElement;
          el.value = v;
          el.dispatchEvent(new Event('input', {bubbles: true}));
        },
        selector,
        value,
      );
      await delay(200);
    };
    // "Add Bank" appends a row; its name/path fields then configure it.
    await page.click('.hanzi-bank-add');
    await delay(400);
    await setBankField('.hanzi-bank-name', 'Capitals');
    await setBankField('.hanzi-bank-path', 'capitals-cards.md');
    // A second bank, used by the reversible-card test (STEP 10).
    await page.click('.hanzi-bank-add');
    await delay(400);
    await setBankField('.hanzi-bank-name', 'German');
    await setBankField('.hanzi-bank-path', 'german-cards.md');
    // Both bank rows must be visible in the list at once.
    const bankRowCount = await page.evaluate(
      () => document.querySelectorAll('.hanzi-bank-row-setting').length,
    );
    if (bankRowCount !== 2) {
      throw new Error(`Expected 2 bank rows in settings, got ${bankRowCount}`);
    }
    // Earlier settings-close parse notices may still be mid-fade here —
    // dismiss them so the golden is deterministic (see the step9 note below).
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });
    await takeAndCompareScreenshot(page, 'step9-bank-settings');
    // Closing settings triggers hide(), which re-parses every bank file.
    await page.keyboard.press('Escape');
    await delay(500);
    const bankSettings = await page.evaluate(() => {
      return (window as any).app.plugins.plugins['hanzi-practice'].settings
        .banks;
    });
    const expectedBanks = [
      {name: 'Capitals', filePath: 'capitals-cards.md'},
      {name: 'German', filePath: 'german-cards.md'},
    ];
    if (JSON.stringify(bankSettings) !== JSON.stringify(expectedBanks)) {
      throw new Error(
        `Bank settings wrong: ${JSON.stringify(bankSettings)}, expected ${JSON.stringify(expectedBanks)}`,
      );
    }
    console.log('Verified banks configured with their own storage files.');

    console.log('STEP 9b: Adding a flashcard via the add-flash-card modal...');
    const flashOpened = await page.evaluate(() => {
      return (window as any).app.commands.executeCommandById(
        'hanzi-practice:add-flash-card',
      );
    });
    if (!flashOpened) {
      throw new Error(
        'Command hanzi-practice:add-flash-card failed to execute',
      );
    }
    await page.waitForSelector('.modal .flash-bank-dropdown', {
      timeout: 10000,
    });
    // The settings-close parse notice would otherwise linger in screenshots.
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });
    // Pick the bank from the dropdown (option values are bank indexes), then
    // fill front and back (textareas). Real key/change events throughout.
    await page.select('.modal .flash-bank-dropdown', '0'); // Capitals
    const textareas = await page.$$('.modal textarea');
    if (textareas.length < 2) {
      throw new Error(
        `Expected front+back textareas in add-flash-card modal, found ${textareas.length}`,
      );
    }
    await textareas[0].type('France');
    await textareas[1].type('Paris');
    await takeAndCompareScreenshot(page, 'step9-add-flashcard');
    await page.evaluate(() => {
      const btn = document.querySelector(
        '.modal button.mod-cta',
      ) as HTMLElement | null;
      if (btn) btn.click();
    });
    // The modal stays open for batch entry; the card lands in the BANK's own
    // file (capitals-cards.md), never in the hanzi words file.
    const capitalsMdPath = path.join(vaultPath, 'capitals-cards.md');
    const flashId = computeFlashcardId('Capitals', 'France', 'Paris');
    let flashLineOk = false;
    for (let i = 0; i < 20; i++) {
      const cards = fs.existsSync(capitalsMdPath)
        ? fs.readFileSync(capitalsMdPath, 'utf-8')
        : '';
      if (cards.includes(`France\tParis\t\t${flashId}\t1\tCapitals`)) {
        flashLineOk = true;
        break;
      }
      await delay(250);
    }
    if (!flashLineOk) {
      throw new Error(
        'Flashcard line (front/back/id/cardType/bank) not written to capitals-cards.md',
      );
    }
    if (fs.readFileSync(practiceMdPath, 'utf-8').includes('France')) {
      throw new Error(
        'Flashcard leaked into the hanzi words file instead of its bank file',
      );
    }
    console.log("Verified flashcard line cached into the bank's own file.");
    await page.keyboard.press('Escape');
    await delay(500);
    // Notices ("Added card…", earlier "Removed…") fade out on their own 5s
    // timers, so whether one is mid-fade in a screenshot is run-timing
    // dependent — dismiss them all so the step9 goldens are deterministic.
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });

    console.log('STEP 9b: Practice command lists banks; picking Capitals...');
    const practiceOpened = await page.evaluate(() => {
      return (window as any).app.commands.executeCommandById(
        'hanzi-practice:practice',
      );
    });
    if (!practiceOpened) {
      throw new Error('Command hanzi-practice:practice failed to execute');
    }
    await page.waitForSelector('.modal .practice-bank-option', {
      timeout: 10000,
    });
    const bankLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.modal .practice-bank-option')).map(
        b => b.querySelector('.practice-bank-name')?.textContent ?? null,
      ),
    );
    // Hanzi must be listed first; both configured banks must be present —
    // including German, which has no cards yet (configured banks always show).
    if (
      bankLabels[0] !== 'Hanzi' ||
      !bankLabels.includes('Capitals') ||
      !bankLabels.includes('German')
    ) {
      throw new Error(
        `Bank selector wrong: expected [Hanzi, Capitals, German], got ${JSON.stringify(bankLabels)}`,
      );
    }
    await takeAndCompareScreenshot(page, 'step9-bank-select');
    await page.evaluate(() => {
      const target = Array.from(
        document.querySelectorAll('.modal .practice-bank-option'),
      ).find(
        b => b.querySelector('.practice-bank-name')?.textContent === 'Capitals',
      );
      (target as HTMLElement | undefined)?.click();
    });

    console.log('STEP 9c: Flip the flashcard and grade it...');
    await page.waitForSelector('.flash-card', {timeout: 10000});
    const beforeFlip = await page.evaluate(() => {
      const front = document.querySelector('.flash-card-front') as HTMLElement;
      const back = document.querySelector('.flash-card-back') as HTMLElement;
      const grades = document.querySelector(
        '.flash-card-grades',
      ) as HTMLElement;
      return {
        front: front?.textContent ?? null,
        backHidden: back ? back.style.display === 'none' : false,
        gradesHidden: grades ? grades.style.display === 'none' : false,
      };
    });
    if (
      beforeFlip.front !== 'France' ||
      !beforeFlip.backHidden ||
      !beforeFlip.gradesHidden
    ) {
      throw new Error(
        `Flashcard front state wrong: ${JSON.stringify(beforeFlip)}`,
      );
    }
    await takeAndCompareScreenshot(page, 'step9-flashcard-front');
    await page.click('.flash-card-flip');
    const afterFlip = await page.evaluate(() => {
      const back = document.querySelector('.flash-card-back') as HTMLElement;
      const grades = Array.from(
        document.querySelectorAll('.flash-card-grade'),
      ) as HTMLElement[];
      return {
        back: back?.textContent ?? null,
        backVisible: back ? back.style.display !== 'none' : false,
        gradeLabels: grades.map(g => g.textContent),
        gradeScores: grades.map(g => g.dataset.score),
      };
    });
    if (
      afterFlip.back !== 'Paris' ||
      !afterFlip.backVisible ||
      afterFlip.gradeLabels.join(',') !==
        'Very Easy,Easy,Hard,Very Hard,No Idea' ||
      afterFlip.gradeScores.join(',') !== '5,4,3,2,0'
    ) {
      throw new Error(
        `Flashcard flip state wrong: ${JSON.stringify(afterFlip)}`,
      );
    }
    console.log('Verified flip reveals the back and the 5 grade buttons.');
    await takeAndCompareScreenshot(page, 'step9-flashcard-back');
    await page.evaluate(() => {
      const easy = Array.from(
        document.querySelectorAll('.flash-card-grade'),
      ).find(b => (b as HTMLElement).dataset.score === '4');
      (easy as HTMLElement | undefined)?.click();
    });
    let flashHistoryOk = false;
    for (let i = 0; i < 20; i++) {
      const history = fs.existsSync(historyMdPath)
        ? fs.readFileSync(historyMdPath, 'utf-8')
        : '';
      if (history.includes(`${flashId} France (Paris): 4`)) {
        flashHistoryOk = true;
        break;
      }
      await delay(250);
    }
    if (!flashHistoryOk) {
      throw new Error(
        'Graded flashcard did not append an id-keyed history line',
      );
    }
    console.log('Verified flashcard grade written to history, keyed by id.');
    // Only card in the bank → the view advances to it again.
    await page.waitForSelector('.flash-card-flip', {timeout: 10000});

    // STEP 10: Reversible flashcard — add one to the German bank with the
    // reversible toggle ON, then practice it. Which side is the prompt is
    // RANDOM for reversible cards, so this step is deliberately non-visual:
    // assert the shown side is one of the two and the flip reveals the other,
    // then verify the graded history entry (whose label is always the stored
    // front (back), independent of the side that was shown).
    console.log('STEP 10: Adding a REVERSIBLE flashcard to the German bank...');
    const revOpened = await page.evaluate(() => {
      return (window as any).app.commands.executeCommandById(
        'hanzi-practice:add-flash-card',
      );
    });
    if (!revOpened) {
      throw new Error(
        'Command hanzi-practice:add-flash-card failed to execute (step 10)',
      );
    }
    await page.waitForSelector('.modal .flash-bank-dropdown', {
      timeout: 10000,
    });
    await page.select('.modal .flash-bank-dropdown', '1'); // German
    const revAreas = await page.$$('.modal textarea');
    await revAreas[0].type('dog');
    await revAreas[1].type('Hund');
    await page.click('.modal .flash-reversible-toggle');
    await dump(page, 'step10-add-reversible');
    await page.evaluate(() => {
      const btn = document.querySelector(
        '.modal button.mod-cta',
      ) as HTMLElement | null;
      if (btn) btn.click();
    });
    const germanMdPath = path.join(vaultPath, 'german-cards.md');
    const revId = computeFlashcardId('German', 'dog', 'Hund');
    let revLineOk = false;
    for (let i = 0; i < 20; i++) {
      const cards = fs.existsSync(germanMdPath)
        ? fs.readFileSync(germanMdPath, 'utf-8')
        : '';
      // Card type 2 = reversible.
      if (cards.includes(`dog\tHund\t\t${revId}\t2\tGerman`)) {
        revLineOk = true;
        break;
      }
      await delay(250);
    }
    if (!revLineOk) {
      throw new Error(
        'Reversible flashcard line (cardType 2) not written to german-cards.md',
      );
    }
    console.log('Verified reversible card (type 2) in german-cards.md.');
    await page.keyboard.press('Escape');
    await delay(500);

    console.log('STEP 10b: Practicing the reversible card...');
    const revPractice = await page.evaluate(() => {
      return (window as any).app.commands.executeCommandById(
        'hanzi-practice:practice',
      );
    });
    if (!revPractice) {
      throw new Error('Command hanzi-practice:practice failed (step 10b)');
    }
    await page.waitForSelector('.modal .practice-bank-option', {
      timeout: 10000,
    });
    await page.evaluate(() => {
      const target = Array.from(
        document.querySelectorAll('.modal .practice-bank-option'),
      ).find(
        b => b.querySelector('.practice-bank-name')?.textContent === 'German',
      );
      (target as HTMLElement | undefined)?.click();
    });
    await page.waitForSelector('.flash-card', {timeout: 10000});
    // Poll until the German card is the one on screen (the view may briefly
    // still show the Capitals card from step 9c while it re-renders).
    let revShown: {front: string | null; backHidden: boolean} = {
      front: null,
      backHidden: false,
    };
    for (let i = 0; i < 40; i++) {
      revShown = await page.evaluate(() => {
        const front = document.querySelector(
          '.flash-card-front',
        ) as HTMLElement | null;
        const back = document.querySelector(
          '.flash-card-back',
        ) as HTMLElement | null;
        return {
          front: front?.textContent ?? null,
          backHidden: back ? back.style.display === 'none' : false,
        };
      });
      if (revShown.front === 'dog' || revShown.front === 'Hund') break;
      await delay(250);
    }
    // Either side may be the prompt — but it must be one of the two, with
    // the answer hidden until the flip.
    if (
      (revShown.front !== 'dog' && revShown.front !== 'Hund') ||
      !revShown.backHidden
    ) {
      throw new Error(
        `Reversible card prompt state wrong: ${JSON.stringify(revShown)}`,
      );
    }
    await dump(page, 'step10-reversible-prompt');
    await page.click('.flash-card-flip');
    const revFlipped = await page.evaluate(() => {
      const front = document.querySelector(
        '.flash-card-front',
      ) as HTMLElement | null;
      const back = document.querySelector(
        '.flash-card-back',
      ) as HTMLElement | null;
      return {
        front: front?.textContent ?? null,
        back: back?.textContent ?? null,
        backVisible: back ? back.style.display !== 'none' : false,
      };
    });
    const sides = [revFlipped.front, revFlipped.back].sort();
    if (
      !revFlipped.backVisible ||
      JSON.stringify(sides) !== JSON.stringify(['Hund', 'dog'].sort())
    ) {
      throw new Error(
        `Reversible flip wrong (must reveal the OTHER side): ${JSON.stringify(revFlipped)}`,
      );
    }
    console.log(`Verified reversible flip (prompt was "${revFlipped.front}").`);
    await dump(page, 'step10-reversible-flipped');
    await page.evaluate(() => {
      const veryEasy = Array.from(
        document.querySelectorAll('.flash-card-grade'),
      ).find(b => (b as HTMLElement).dataset.score === '5');
      (veryEasy as HTMLElement | undefined)?.click();
    });
    let revHistoryOk = false;
    for (let i = 0; i < 20; i++) {
      const history = fs.existsSync(historyMdPath)
        ? fs.readFileSync(historyMdPath, 'utf-8')
        : '';
      if (history.includes(`${revId} dog (Hund): 5`)) {
        revHistoryOk = true;
        break;
      }
      await delay(250);
    }
    if (!revHistoryOk) {
      throw new Error(
        'Graded reversible card did not append its id-keyed history line',
      );
    }
    console.log(
      'Verified reversible-card grade in history, keyed by id with stored front (back) label.',
    );

    // STEP 11: Multiple-choice card (type 3) — add one to Capitals via the
    // card-type dropdown, then practice it: a wrong pick must be marked and
    // counted, the correct pick completes and auto-grades (1 mistake → 2).
    // Goldens: the shuffled options are DOM-sorted before each screenshot
    // so the pixels are deterministic.
    console.log('STEP 11: Adding a MULTIPLE-CHOICE card to Capitals...');
    const mcOpened = await page.evaluate(() => {
      return (window as any).app.commands.executeCommandById(
        'hanzi-practice:add-flash-card',
      );
    });
    if (!mcOpened) {
      throw new Error(
        'Command hanzi-practice:add-flash-card failed to execute (step 11)',
      );
    }
    await page.waitForSelector('.modal .flash-type-dropdown', {
      timeout: 10000,
    });
    await page.select('.modal .flash-bank-dropdown', '0'); // Capitals
    await page.select('.modal .flash-type-dropdown', '3'); // Multiple choice
    await delay(300);
    // Switching the type swaps the field set: question/answer/wrong-options.
    const mcAreas = await page.$$('.modal textarea');
    if (mcAreas.length !== 3) {
      throw new Error(
        `Expected 3 textareas after selecting Multiple choice, found ${mcAreas.length}`,
      );
    }
    await mcAreas[0].type('你__狗吗？');
    await mcAreas[1].type('有没有');
    // Distractors are one per line; set via input event so the newline can't
    // be misread as a keyboard action.
    await page.evaluate(() => {
      const areas = document.querySelectorAll('.modal textarea');
      const el = areas[2] as HTMLTextAreaElement;
      el.value = '不有\n没不有';
      el.dispatchEvent(new Event('input', {bubbles: true}));
    });
    // Notices fade on their own 5s timers — strip them before every golden
    // (same determinism rule as the step9 screenshots).
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });
    await takeAndCompareScreenshot(page, 'step11-add-mc');
    await page.evaluate(() => {
      const btn = document.querySelector(
        '.modal button.mod-cta',
      ) as HTMLElement | null;
      if (btn) btn.click();
    });
    const mcId = computeMultiChoiceId('Capitals', '你__狗吗？', '有没有');
    let mcLineOk = false;
    for (let i = 0; i < 20; i++) {
      const cards = fs.existsSync(capitalsMdPath)
        ? fs.readFileSync(capitalsMdPath, 'utf-8')
        : '';
      // Card type 3; distractors |-joined in f2.
      if (
        cards.includes(`你__狗吗？\t有没有\t不有|没不有\t${mcId}\t3\tCapitals`)
      ) {
        mcLineOk = true;
        break;
      }
      await delay(250);
    }
    if (!mcLineOk) {
      throw new Error(
        'Multiple-choice line (cardType 3, |-joined distractors) not written to capitals-cards.md',
      );
    }
    console.log('Verified multiple-choice card (type 3) in capitals-cards.md.');
    await page.keyboard.press('Escape');
    await delay(500);

    console.log('STEP 11b: Practicing the multiple-choice card...');
    const mcPractice = await page.evaluate(() => {
      return (window as any).app.commands.executeCommandById(
        'hanzi-practice:practice',
      );
    });
    if (!mcPractice) {
      throw new Error('Command hanzi-practice:practice failed (step 11b)');
    }
    await page.waitForSelector('.modal .practice-bank-option', {
      timeout: 10000,
    });
    await page.evaluate(() => {
      const target = Array.from(
        document.querySelectorAll('.modal .practice-bank-option'),
      ).find(
        b => b.querySelector('.practice-bank-name')?.textContent === 'Capitals',
      );
      (target as HTMLElement | undefined)?.click();
    });
    // The new card is the only strictly-due card in Capitals (the France
    // flashcard was graded 4 in step 9c → due tomorrow), so it must show.
    await page.waitForSelector('.mc-card', {timeout: 10000});
    const mcState = await page.evaluate(() => {
      const question = document.querySelector(
        '.mc-question',
      ) as HTMLElement | null;
      const options = Array.from(
        document.querySelectorAll('.mc-option'),
      ) as HTMLElement[];
      return {
        question: question?.textContent ?? null,
        options: options.map(o => o.textContent),
      };
    });
    if (
      mcState.question !== '你__狗吗？' ||
      mcState.options.length !== 3 ||
      [...mcState.options].sort().join(',') !==
        ['有没有', '不有', '没不有'].sort().join(',')
    ) {
      throw new Error(
        `Multiple-choice card state wrong: ${JSON.stringify(mcState)}`,
      );
    }
    // The options render Fisher-Yates shuffled, which would flake a pixel
    // golden — reorder the buttons deterministically (by text) in the DOM
    // before screenshotting. Handlers travel with the elements, so the
    // interaction assertions below are unaffected.
    await page.evaluate(() => {
      const container = document.querySelector('.mc-options');
      if (!container) return;
      Array.from(container.querySelectorAll('.mc-option'))
        .sort((a, b) =>
          (a.textContent ?? '').localeCompare(b.textContent ?? '', 'zh'),
        )
        .forEach(b => container.appendChild(b));
    });
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });
    await takeAndCompareScreenshot(page, 'step11-mc-options');
    // Pick a WRONG option first: it must be marked + disabled, and the card
    // must not complete.
    const wrongMarked = await page.evaluate(() => {
      const wrong = Array.from(document.querySelectorAll('.mc-option')).find(
        b => b.textContent === '不有',
      ) as HTMLButtonElement | undefined;
      if (!wrong) return null;
      wrong.click();
      return {
        disabled: wrong.disabled,
        border: wrong.style.border,
        completed: !document.querySelector('.mc-card'),
      };
    });
    if (
      !wrongMarked ||
      !wrongMarked.disabled ||
      !wrongMarked.border.includes('red') ||
      wrongMarked.completed
    ) {
      throw new Error(
        `Wrong-pick handling broken: ${JSON.stringify(wrongMarked)}`,
      );
    }
    console.log('Verified wrong pick is marked, counted, and non-final.');
    // Options are still in the sorted order from the previous golden, so the
    // red-marked wrong pick is pixel-stable too.
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });
    await takeAndCompareScreenshot(page, 'step11-mc-wrong-pick');
    // Now the correct option: completes the card and auto-grades it. One
    // wrong pick → score 2 (fail — the card comes back today).
    await page.evaluate(() => {
      const correct = Array.from(document.querySelectorAll('.mc-option')).find(
        b => b.textContent === '有没有',
      ) as HTMLElement | undefined;
      correct?.click();
    });
    let mcHistoryOk = false;
    for (let i = 0; i < 20; i++) {
      const history = fs.existsSync(historyMdPath)
        ? fs.readFileSync(historyMdPath, 'utf-8')
        : '';
      if (history.includes(`${mcId} 你__狗吗？ (有没有): 2`)) {
        mcHistoryOk = true;
        break;
      }
      await delay(250);
    }
    if (!mcHistoryOk) {
      throw new Error(
        'Multiple-choice card did not auto-grade 2 after one wrong pick',
      );
    }
    console.log('Verified auto-grade (1 mistake → 2) written to history.');
    // Score 2 = fail → the card is due again immediately; the view advances
    // back to it.
    await page.waitForSelector('.mc-card', {timeout: 10000});
    await dump(page, 'step11-mc-regraded');

    // STEP 12: Cloze card (type 4) — the sentence's {{…}} answers render as
    // blanks, reveal shows the full sentence, then self-grade like a
    // flashcard.
    console.log('STEP 12: Adding a CLOZE card to the German bank...');
    const clozeOpened = await page.evaluate(() => {
      return (window as any).app.commands.executeCommandById(
        'hanzi-practice:add-flash-card',
      );
    });
    if (!clozeOpened) {
      throw new Error(
        'Command hanzi-practice:add-flash-card failed to execute (step 12)',
      );
    }
    await page.waitForSelector('.modal .flash-type-dropdown', {
      timeout: 10000,
    });
    await page.select('.modal .flash-bank-dropdown', '1'); // German
    await page.select('.modal .flash-type-dropdown', '4'); // Fill in the blank
    await delay(300);
    const clozeAreas = await page.$$('.modal textarea');
    if (clozeAreas.length !== 2) {
      throw new Error(
        `Expected 2 textareas after selecting Fill in the blank, found ${clozeAreas.length}`,
      );
    }
    await clozeAreas[0].type('我一个星期{{没}}吃饭。');
    await clozeAreas[1].type("I haven't eaten for a week.");
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });
    await takeAndCompareScreenshot(page, 'step12-add-cloze');
    await page.evaluate(() => {
      const btn = document.querySelector(
        '.modal button.mod-cta',
      ) as HTMLElement | null;
      if (btn) btn.click();
    });
    const clozeId = computeClozeId('German', '我一个星期{{没}}吃饭。');
    let clozeLineOk = false;
    for (let i = 0; i < 20; i++) {
      const cards = fs.existsSync(germanMdPath)
        ? fs.readFileSync(germanMdPath, 'utf-8')
        : '';
      // Card type 4: text, hint, empty f2.
      if (
        cards.includes(
          `我一个星期{{没}}吃饭。\tI haven't eaten for a week.\t\t${clozeId}\t4\tGerman`,
        )
      ) {
        clozeLineOk = true;
        break;
      }
      await delay(250);
    }
    if (!clozeLineOk) {
      throw new Error('Cloze line (cardType 4) not written to german-cards.md');
    }
    console.log('Verified cloze card (type 4) in german-cards.md.');
    await page.keyboard.press('Escape');
    await delay(500);

    console.log('STEP 12b: Practicing the cloze card...');
    const clozePractice = await page.evaluate(() => {
      return (window as any).app.commands.executeCommandById(
        'hanzi-practice:practice',
      );
    });
    if (!clozePractice) {
      throw new Error('Command hanzi-practice:practice failed (step 12b)');
    }
    await page.waitForSelector('.modal .practice-bank-option', {
      timeout: 10000,
    });
    await page.evaluate(() => {
      const target = Array.from(
        document.querySelectorAll('.modal .practice-bank-option'),
      ).find(
        b => b.querySelector('.practice-bank-name')?.textContent === 'German',
      );
      (target as HTMLElement | undefined)?.click();
    });
    // The cloze card is the only strictly-due card in German (dog was graded
    // 5 in step 10 → due tomorrow), so it must show, blanked.
    await page.waitForSelector('.cloze-card', {timeout: 10000});
    const clozePromptState = await page.evaluate(() => {
      const prompt = document.querySelector(
        '.cloze-prompt',
      ) as HTMLElement | null;
      const hint = document.querySelector('.cloze-hint') as HTMLElement | null;
      const answer = document.querySelector(
        '.cloze-answer',
      ) as HTMLElement | null;
      const grades = document.querySelector(
        '.cloze-grades',
      ) as HTMLElement | null;
      return {
        prompt: prompt?.textContent ?? null,
        hint: hint?.textContent ?? null,
        answerHidden: answer ? answer.style.display === 'none' : false,
        gradesHidden: grades ? grades.style.display === 'none' : false,
      };
    });
    if (
      clozePromptState.prompt !== '我一个星期____吃饭。' ||
      clozePromptState.hint !== "I haven't eaten for a week." ||
      !clozePromptState.answerHidden ||
      !clozePromptState.gradesHidden
    ) {
      throw new Error(
        `Cloze prompt state wrong (blank must hide 没): ${JSON.stringify(clozePromptState)}`,
      );
    }
    console.log('Verified the {{…}} answer renders blanked with the hint.');
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });
    await takeAndCompareScreenshot(page, 'step12-cloze-prompt');
    await page.click('.cloze-reveal');
    const clozeRevealed = await page.evaluate(() => {
      const answer = document.querySelector(
        '.cloze-answer',
      ) as HTMLElement | null;
      const grades = Array.from(
        document.querySelectorAll('.cloze-grade'),
      ) as HTMLElement[];
      return {
        answer: answer?.textContent ?? null,
        answerVisible: answer ? answer.style.display !== 'none' : false,
        gradeLabels: grades.map(g => g.textContent),
        gradeScores: grades.map(g => g.dataset.score),
      };
    });
    if (
      clozeRevealed.answer !== '我一个星期没吃饭。' ||
      !clozeRevealed.answerVisible ||
      clozeRevealed.gradeLabels.join(',') !==
        'Very Easy,Easy,Hard,Very Hard,No Idea' ||
      clozeRevealed.gradeScores.join(',') !== '5,4,3,2,0'
    ) {
      throw new Error(
        `Cloze reveal state wrong: ${JSON.stringify(clozeRevealed)}`,
      );
    }
    console.log('Verified reveal shows the full sentence + 5 grade buttons.');
    await page.evaluate(() => {
      document
        .querySelectorAll('.notice')
        .forEach(n => (n as HTMLElement).remove());
    });
    await takeAndCompareScreenshot(page, 'step12-cloze-revealed');
    await page.evaluate(() => {
      const hard = Array.from(document.querySelectorAll('.cloze-grade')).find(
        b => (b as HTMLElement).dataset.score === '3',
      );
      (hard as HTMLElement | undefined)?.click();
    });
    let clozeHistoryOk = false;
    for (let i = 0; i < 20; i++) {
      const history = fs.existsSync(historyMdPath)
        ? fs.readFileSync(historyMdPath, 'utf-8')
        : '';
      // The label flattens {{没}} to [没] for readability.
      if (
        history.includes(
          `${clozeId} 我一个星期[没]吃饭。 (I haven't eaten for a week.): 3`,
        )
      ) {
        clozeHistoryOk = true;
        break;
      }
      await delay(250);
    }
    if (!clozeHistoryOk) {
      throw new Error(
        'Graded cloze card did not append its id-keyed history line',
      );
    }
    console.log(
      'Verified cloze grade in history with the bracket-flattened label.',
    );

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
