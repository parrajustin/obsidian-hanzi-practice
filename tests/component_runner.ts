/**
 * COMPONENT golden test for the quiz writer (src/writer) + stroke data
 * (src/data) — no plugin, no vault content, no Obsidian UI in frame.
 *
 * It launches the same extracted Obsidian AppImage the E2E uses (it is the
 * only browser this repo ships), but only as a Chromium host: the window's
 * body is cleared and the bundled harness (tests/component_harness.js) mounts
 * ONLY a HanziQuizWriter on a fixed white stage, fed with the REAL shipped
 * stroke database (dist/hanzi-strokes.bin.gz). Every state is driven by
 * synthetic pointer events at fixed coordinates and screenshotted CLIPPED to
 * the stage, so goldens contain nothing but the component.
 *
 * States covered (golden `component-<name>.png` in tests/__goldens__, docker
 * runs compare against docker/__golden__ via the bind mount):
 *   empty            fresh quiz, blank box
 *   ink              mid-stroke user ink (pointer still down)
 *   hint             expected stroke highlighted after 3 misses
 *   progress         3 strokes accepted, hint cleared
 *   complete         all 6 strokes accepted
 *   outline          showOutline() (Give Up)
 *   animation-start  animateCharacter(): first stroke only (transitions off)
 *   animation-end    animateCharacter(): finished character
 *
 * Functional assertions (mistake counts, hint appearance/clearing, event
 * callbacks, completion summary) are the source of truth; pixel diffs are
 * advisory (E2E_STRICT_VISUAL=1 makes them fatal), same policy as the E2E.
 *
 * Run: npm run test:component        (regen: npm run test:component:goldens)
 * Docker: npm run test:component:docker[:goldens]
 */
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as zlib from 'zlib';
import puppeteer from 'puppeteer-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const LOG_PATH = path.join(__dirname, '..', 'component-run.log');
try { fs.writeFileSync(LOG_PATH, ''); } catch (e) {}
function log(...args: any[]) {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    // eslint-disable-next-line no-console
    console.log(line);
    try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch (e) {}
}

const DUMPS_DIR = path.join(__dirname, '..', 'dumps-component');
let dumpCount = 0;
function clearDumps() {
    try { fs.rmSync(DUMPS_DIR, { recursive: true, force: true }); } catch (e) {}
    try { fs.mkdirSync(DUMPS_DIR, { recursive: true }); } catch (e) {}
    dumpCount = 0;
}

async function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const GOLDEN_PREFIX = 'component-';
const GOLDEN_DIR = path.join(__dirname, '__goldens__');

// Clip-screenshot the harness stage and compare against the golden. Same
// advisory policy as the E2E runner; goldens are prefix-scoped so this runner
// and the E2E can regenerate independently into the shared __goldens__ dir.
async function compareStageScreenshot(page: any, name: string, clip: { x: number; y: number; width: number; height: number }) {
    const fullName = `${GOLDEN_PREFIX}${name}`;
    const n = String(++dumpCount).padStart(2, '0');
    const dumpPath = path.join(DUMPS_DIR, `${n}-${fullName}.png`);
    await page.screenshot({ path: dumpPath, clip });
    log(`[dump] ${n}-${fullName}`);

    const goldenPath = path.join(GOLDEN_DIR, `${fullName}.png`);
    if (!fs.existsSync(goldenPath)) {
        log(`Golden for ${fullName} not found, saving new golden.`);
        fs.copyFileSync(dumpPath, goldenPath);
        return;
    }
    const img1 = PNG.sync.read(fs.readFileSync(dumpPath));
    const img2 = PNG.sync.read(fs.readFileSync(goldenPath));
    const strict = process.env.E2E_STRICT_VISUAL === '1';
    if (img1.width !== img2.width || img1.height !== img2.height) {
        const msg = `[visual] size mismatch for ${fullName}: expected ${img2.width}x${img2.height}, got ${img1.width}x${img1.height}`;
        if (strict) throw new Error(msg);
        log('WARN', msg);
        return;
    }
    const diff = new PNG({ width: img1.width, height: img1.height });
    const numDiffPixels = pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, { threshold: 0.1 });
    if (numDiffPixels > 100) { // component clips are small + font-free, so keep this tight
        const diffPath = path.join(__dirname, '..', `${fullName}-diff.png`);
        fs.writeFileSync(diffPath, PNG.sync.write(diff));
        const msg = `[visual] ${fullName}: ${numDiffPixels} pixels differ vs golden. Diff saved to ${diffPath}`;
        if (strict) throw new Error(msg);
        log('WARN', msg);
    } else {
        log(`[visual] ${fullName} matches golden (${numDiffPixels} px diff).`);
    }
}

// Use a different debug port + profile than the E2E so a leftover instance of
// one suite can never single-instance-lock the other.
const DEBUG_PORT = 9226;

function portInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = require('http').get(`http://127.0.0.1:${port}/json/version`, (res: any) => {
            res.resume();
            resolve(true);
        });
        req.setTimeout(800, () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

// Kill every test-Obsidian process (scoped to the extracted test AppImage
// path only — never a normally-installed Obsidian).
function reapTestObsidian() {
    try { cp.execSync('pkill -9 -f "squashfs-root/obsidian"', { stdio: 'ignore' }); } catch (e) {}
}

async function killLingeringObsidian() {
    reapTestObsidian();
    for (let i = 0; i < 20; i++) {
        if (!(await portInUse(DEBUG_PORT))) return;
        await delay(500);
    }
}

function regenGoldensIfRequested() {
    if (process.env.E2E_REGEN_GOLDENS !== '1') return;
    let removed = 0;
    try {
        for (const f of fs.readdirSync(GOLDEN_DIR)) {
            // Scoped: only this runner's goldens — never the E2E's step*.png.
            if (f.startsWith(GOLDEN_PREFIX) && f.endsWith('.png')) {
                fs.rmSync(path.join(GOLDEN_DIR, f));
                removed++;
            }
        }
    } catch (e) { /* dir may not exist yet */ }
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    log(`E2E_REGEN_GOLDENS=1: removed ${removed} old ${GOLDEN_PREFIX}*.png golden(s); this run will save fresh ones.`);
}

function assert(cond: boolean, msg: string, state?: unknown) {
    if (!cond) {
        throw new Error(`${msg}${state !== undefined ? ` — state: ${JSON.stringify(state)}` : ''}`);
    }
}

async function run() {
    let runOk = false;
    await killLingeringObsidian();
    clearDumps();
    regenGoldensIfRequested();

    // Inputs produced by `npm run build` / `npm run build:e2e`.
    const strokesGzPath = path.join(__dirname, '..', 'dist', 'hanzi-strokes.bin.gz');
    const harnessJsPath = path.join(__dirname, 'component_harness.js');
    if (!fs.existsSync(strokesGzPath)) {
        throw new Error(`${strokesGzPath} not found — run \`npm run build\` first.`);
    }
    if (!fs.existsSync(harnessJsPath)) {
        throw new Error(`${harnessJsPath} not found — run \`npm run build:e2e\` first.`);
    }
    const strokeDataB64 = zlib.gunzipSync(fs.readFileSync(strokesGzPath)).toString('base64');
    const harnessJs = fs.readFileSync(harnessJsPath, 'utf8');

    // A minimal EMPTY vault (no plugins -> no trust prompt) just to get a
    // rendered Chromium window out of Obsidian.
    const vaultPath = path.join(__dirname, '..', 'component_vault');
    const profilePath = '/tmp/obsidian-component-profile';
    fs.rmSync(vaultPath, { recursive: true, force: true });
    fs.rmSync(profilePath, { recursive: true, force: true });
    fs.mkdirSync(path.join(vaultPath, '.obsidian'), { recursive: true });
    fs.mkdirSync(profilePath, { recursive: true });
    // With --user-data-dir=X the vault registry lives at X/obsidian.json.
    fs.writeFileSync(path.join(profilePath, 'obsidian.json'), JSON.stringify({
        vaults: { 'component-test-vault': { path: vaultPath, ts: Date.now(), open: true } },
    }, null, 2));

    log('Starting Obsidian (component host)...');
    const appImage = path.join(__dirname, '..', 'squashfs-root', 'obsidian');
    const child = cp.spawn(appImage, [vaultPath, `--user-data-dir=${profilePath}`, `--remote-debugging-port=${DEBUG_PORT}`, '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--ozone-platform=x11'], {
        detached: true,
        stdio: 'pipe'
    });
    child.stdout.on('data', (d: any) => log('OBSIDIAN:', d.toString().trim()));
    child.stderr.on('data', (d: any) => log('OBSIDIAN ERR:', d.toString().trim()));
    child.on('exit', (code: any, sig: any) => log(`OBSIDIAN process exited early: code=${code} sig=${sig}`));
    child.unref();

    await delay(8000);

    log('Connecting Puppeteer...');
    let browser: any;
    for (let i = 0; i < 30; i++) {
        try {
            browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null });
            break;
        } catch (e: any) {
            log('Retry connect...', e.message);
            await delay(2000);
        }
    }
    if (!browser) {
        throw new Error(`Could not connect to Obsidian on port ${DEBUG_PORT}`);
    }

    let page: any = null;
    try {
        // Find the loaded workspace window (same polling approach as the E2E).
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            for (const t of browser.targets().filter((t: any) => t.type() === 'page')) {
                let p: any = null;
                try { p = await t.page(); } catch (e) { continue; }
                if (!p) continue;
                let ready = false;
                try {
                    ready = await p.evaluate(() => {
                        const w = window as any;
                        return !!(w.app && w.app.workspace && w.app.workspace.layoutReady);
                    });
                } catch (e) { /* context tearing down */ }
                if (ready) { page = p; break; }
            }
            if (page) break;
            await delay(2000);
        }
        if (!page) throw new Error('Could not find a loaded Obsidian workspace page');
        page.on('pageerror', (err: any) => log('PAGE ERROR:', err.toString()));
        log('Connected. Injecting harness...');

        await page.addScriptTag({ content: harnessJs });

        // Small helpers: everything below drives window.componentHarness.
        // NOTE: the expression is evaluated as plain JS inside the page — no
        // TypeScript syntax allowed in `expr` or this wrapper.
        const h = async (expr: string) => page.evaluate(`(() => { const h = window.componentHarness; return ${expr}; })()`);
        const state = () => h('h.state()');
        const shot = async (name: string) => compareStageScreenshot(page, name, await h('h.rect()'));

        // --- Mount from the real shipped database ---------------------------
        const mounted = await page.evaluate(
            (b64: string) => (window as any).componentHarness.mount(b64, '好'),
            strokeDataB64
        );
        log(`Mounted 好 from shipped stroke DB: ${JSON.stringify(mounted)}`);
        assert(mounted.strokeCount === 6, `好 should have 6 strokes, got ${mounted.strokeCount}`);
        assert(mounted.dbChars > 9000, `stroke DB unexpectedly small (${mounted.dbChars} chars)`);
        await delay(300);
        await shot('empty');

        // --- Mid-stroke ink (pointer held down) -----------------------------
        await h('h.draw([{x:220,y:30},{x:240,y:45},{x:260,y:62},{x:285,y:95}], {holdLast:true})');
        let s = await state();
        assert(s.inkVisible, 'user ink should be visible while the pointer is down', s);
        await shot('ink');
        await h('h.release({x:285,y:95})');
        s = await state();
        assert(!s.inkVisible && s.totalMistakes === 1 && !s.hintShown,
            'released wrong stroke should clear ink and count 1 mistake, no hint yet', s);

        // --- Two more misses -> hint highlight ------------------------------
        await h('h.drawWrong()');
        s = await state();
        assert(s.totalMistakes === 2 && !s.hintShown, 'second miss should not show the hint yet', s);
        await h('h.drawWrong()');
        s = await state();
        assert(s.totalMistakes === 3 && s.mistakesOnCurrentStroke === 3 && s.hintShown,
            'third miss on the same stroke must show the hint highlight', s);
        assert(s.events.filter((e: any) => e.type === 'mistake').length === 3, 'onMistake should have fired 3 times', s);
        await shot('hint');

        // --- Correct strokes: hint clears, progress renders -----------------
        await h('h.drawCorrect(0)');
        s = await state();
        assert(s.strokeIndex === 1 && !s.hintShown && s.doneStrokes === 1 && s.mistakesOnCurrentStroke === 0,
            'correct stroke must advance, clear the hint, and render as done', s);
        await h('h.drawCorrect(1)');
        await h('h.drawCorrect(2)');
        s = await state();
        assert(s.strokeIndex === 3 && s.doneStrokes === 3, 'three strokes should be accepted', s);
        await shot('progress');

        // --- Finish the character ------------------------------------------
        await h('h.drawCorrect(3)');
        await h('h.drawCorrect(4)');
        await h('h.drawCorrect(5)');
        s = await state();
        assert(s.isComplete && s.doneStrokes === 6, 'all six strokes should be accepted', s);
        const completeEvents = s.events.filter((e: any) => e.type === 'complete');
        assert(completeEvents.length === 1 && completeEvents[0].detail.character === '好'
            && completeEvents[0].detail.totalMistakes === 3,
            'onComplete must fire once with the right summary', s.events);
        await shot('complete');

        // --- Give Up rendering: outline + animation -------------------------
        await page.evaluate(
            (b64: string) => (window as any).componentHarness.mount(b64, '好'),
            strokeDataB64
        );
        await h('h.showOutline()');
        s = await state();
        assert(s.outlineStrokes === 6, 'outline should render all six strokes', s);
        await shot('outline');

        // Deterministic "animation just started" frame: transitions disabled
        // (strokes appear whole) and a huge per-stroke delay so only the first
        // stroke's timer has fired when we screenshot.
        await h('h.disableTransitions()');
        await h('h.animate(600000)');
        await delay(400);
        s = await state();
        assert(s.animatedStrokes === 1, 'only the first stroke should be animated in yet', s);
        await shot('animation-start');

        // Full animation at normal speed; poll for all strokes, then let the
        // last dash transition finish so the end frame is stable.
        await h('h.animate()');
        let animated = 0;
        for (let i = 0; i < 30; i++) {
            s = await state();
            animated = s.animatedStrokes;
            if (animated === 6) break;
            await delay(300);
        }
        assert(animated === 6, `animation should render all 6 strokes (got ${animated})`);
        await delay(800);
        await shot('animation-end');

        log('Component steps complete!');
        await browser.disconnect();
        runOk = true;
    } catch (e) {
        log('Error during component run:', (e as Error).stack || String(e));
        if (page) {
            try {
                const n = String(++dumpCount).padStart(2, '0');
                await page.screenshot({ path: path.join(DUMPS_DIR, `${n}-FAILURE.png`) });
                fs.writeFileSync(path.join(DUMPS_DIR, `${n}-FAILURE.html`), await page.content());
            } catch (e2) {}
        }
    } finally {
        try {
            if (child.pid) process.kill(-child.pid, 'SIGTERM');
        } catch (e) {
            try { child.kill('SIGTERM'); } catch (e2) {}
        }
        reapTestObsidian();
    }
    return runOk;
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { reapTestObsidian(); process.exit(1); });
}

run()
    .then((ok) => { reapTestObsidian(); log(ok ? 'RESULT: PASS' : 'RESULT: FAIL'); process.exit(ok ? 0 : 1); })
    .catch((e) => { reapTestObsidian(); log('RESULT: FAIL (threw)', String(e)); process.exit(1); });
