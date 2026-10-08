// Headless playback checks for the static page.
// From the repo root, after `npm install`:
//   node tests/playback.mjs
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = [];
function log(line) {
    lines.push(line);
    console.log(line);
}

const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.mp3': 'audio/mpeg',
    '.gif': 'image/gif',
    '.png': 'image/png',
    '.css': 'text/css',
    '.json': 'application/json',
};

function startServer() {
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://127.0.0.1');
            let pathname = decodeURIComponent(url.pathname);
            if (pathname.endsWith('/')) pathname += 'index.html';
            const path = join(root, pathname);
            if (path !== root && !path.startsWith(root + '/')) {
                res.writeHead(403);
                res.end();
                return;
            }
            const body = await readFile(path);
            res.writeHead(200, {
                'Content-Type': types[extname(path)] || 'application/octet-stream',
                'Content-Length': body.length,
                'Cache-Control': 'no-store',
            });
            res.end(body);
        } catch (err) {
            res.writeHead(err && err.code === 'ENOENT' ? 404 : 500);
            res.end();
        }
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({ server, url: `http://127.0.0.1:${port}/index.html` });
        });
    });
}

const spyScript = `
(() => {
    const sources = [];
    const contexts = [];
    const analysers = [];
    const Orig = window.AudioContext || window.webkitAudioContext;
    if (!Orig) return;
    const origConnect = AudioNode.prototype.connect;
    function WrappedAudioContext(...args) {
        const ctx = new Orig(...args);
        contexts.push(ctx);
        const origCreate = ctx.createBufferSource.bind(ctx);
        ctx.createBufferSource = function () {
            const src = origCreate();
            sources.push(src);
            const origStart = src.start.bind(src);
            src.start = function (...startArgs) {
                src.__started = true;
                return origStart(...startArgs);
            };
            return src;
        };
        return ctx;
    }
    AudioNode.prototype.connect = function (dest, ...rest) {
        const result = origConnect.call(this, dest, ...rest);
        try {
            if (dest === this.context.destination && this instanceof AudioBufferSourceNode) {
                const analyser = this.context.createAnalyser();
                analyser.fftSize = 2048;
                origConnect.call(this, analyser);
                this.__analyser = analyser;
                analysers.push(analyser);
            }
        } catch (e) {}
        return result;
    };
    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = WrappedAudioContext;
    window.__audioLevel = () => {
        let max = 0;
        for (const analyser of analysers) {
            const buf = new Uint8Array(analyser.fftSize);
            analyser.getByteTimeDomainData(buf);
            for (let i = 0; i < buf.length; i++) {
                const delta = Math.abs(buf[i] - 128);
                if (delta > max) max = delta;
            }
        }
        return max;
    };
    window.__audioSpy = { sources, contexts, analysers };
})();
`;

function track(page) {
    const problems = [];
    const warnings = [];
    page.on('pageerror', (err) => problems.push('pageerror: ' + err.message));
    page.on('response', (res) => {
        if (res.status() < 400) return;
        const url = res.url();
        if (/favicon\.ico/i.test(url)) return;
        problems.push(res.status() + ' ' + url);
    });
    page.on('console', (msg) => {
        const text = msg.text();
        if (msg.type() === 'warning') {
            warnings.push(text);
            return;
        }
        if (msg.type() !== 'error') return;
        // Resource failures are recorded from the response, including favicon.
        if (/Failed to load resource/i.test(text)) return;
        if (/favicon\.ico/i.test(text)) return;
        problems.push('console: ' + text);
    });
    return { problems, warnings };
}

async function snapshot(page) {
    return page.evaluate(() => {
        const spy = window.__audioSpy || { sources: [], contexts: [] };
        const ctx = spy.contexts[0] || null;
        const longSources = spy.sources.filter((src) => src.buffer && src.buffer.duration > 1);
        const hint = document.getElementById('play-hint');
        return {
            state: ctx ? ctx.state : null,
            currentTime: ctx ? ctx.currentTime : null,
            longCount: longSources.length,
            startedLong: longSources.filter((src) => src.__started).length,
            loop: longSources.length ? !!longSources[0].loop : false,
            duration: longSources.length ? longSources[0].buffer.duration : null,
            hintHidden: hint ? hint.hidden : null,
            hintText: hint ? hint.textContent.trim() : null,
            hintShown: document.documentElement.dataset.hintShown || '',
            audioState: document.documentElement.dataset.audioState || '',
            audioStates: document.documentElement.dataset.audioStates || '',
            audioReady: document.documentElement.dataset.audioReady || '',
            audioElements: document.querySelectorAll('audio').length,
            audioMode: document.documentElement.dataset.audioMode || '',
            elementPaused: (function () {
                const media = document.getElementById('music');
                return media ? media.paused : null;
            })(),
            elementTime: (function () {
                const media = document.getElementById('music');
                return media ? media.currentTime : null;
            })(),
            elementDuration: (function () {
                const media = document.getElementById('music');
                return media ? media.duration : null;
            })(),
            level: window.__audioLevel ? window.__audioLevel() : 0,
        };
    });
}

async function waitFor(page, fn, arg, timeout, label) {
    try {
        await page.waitForFunction(fn, arg, { timeout });
    } catch (err) {
        const snap = await snapshot(page).catch(() => null);
        throw new Error(label + ' timed out. snapshot=' + JSON.stringify(snap));
    }
}

async function expectLevel(page, minimum, timeout) {
    const started = Date.now();
    let best = 0;
    while (Date.now() - started < timeout) {
        const level = await page.evaluate(() => (window.__audioLevel ? window.__audioLevel() : 0));
        if (level > best) best = level;
        if (level >= minimum) return best;
        await page.waitForTimeout(40);
    }
    return best;
}

function assert(cond, message) {
    if (!cond) throw new Error(message);
}

async function openPage(browser, url) {
    const context = await browser.newContext({ viewport: { width: 960, height: 800 } });
    await context.addInitScript(spyScript);
    const page = await context.newPage();
    const tracked = track(page);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return { context, page, ...tracked };
}

async function waitUntilPlaying(page, label) {
    await waitFor(
        page,
        () => {
            const root = document.documentElement;
            if (root.dataset.audioState !== 'playing') return false;
            if (root.dataset.audioMode === 'buffer') {
                const ctx = window.__audioSpy && window.__audioSpy.contexts[0];
                return !!(ctx && ctx.state === 'running' &&
                    window.__audioSpy.sources.some((src) => src.__started && src.buffer && src.buffer.duration > 1));
            }
            const media = document.getElementById('music');
            return !!(media && !media.paused && media.currentTime >= 0 && media.readyState >= 2);
        },
        null,
        15000,
        label
    );
    // Let a media-element start upgrade to the buffer if the context caught up.
    await page.waitForTimeout(150);
}

async function expectAudible(page) {
    const mode = await page.evaluate(() => document.documentElement.dataset.audioMode || '');
    if (mode === 'element') {
        const before = await page.evaluate(() => document.getElementById('music').currentTime);
        await page.waitForTimeout(350);
        const after = await page.evaluate(() => {
            const media = document.getElementById('music');
            return { time: media.currentTime, paused: media.paused };
        });
        assert(!after.paused, 'element paused');
        assert(after.time > before + 0.15, 'element clock did not advance (' + before + ' -> ' + after.time + ')');
        return { mode, level: null };
    }
    const level = await expectLevel(page, 3, 3000);
    assert(level >= 3, 'buffer produced no signal (level ' + level + ')');
    return { mode, level };
}

async function crossLoopBoundary(page) {
    const mode = await page.evaluate(() => document.documentElement.dataset.audioMode || '');
    if (mode === 'element') return crossElementLoop(page);
    return crossBufferLoop(page);
}

async function crossElementLoop(page) {
    const plan = await page.evaluate(() => {
        const media = document.getElementById('music');
        window.__maxT = media.currentTime;
        media.playbackRate = 16;
        return { duration: media.duration, rate: media.playbackRate, t: media.currentTime };
    });
    assert(Number.isFinite(plan.duration) && plan.duration > 1, 'element duration ' + plan.duration);
    const needMs = Math.ceil((plan.duration / plan.rate) * 1000) + 8000;
    await waitFor(
        page,
        () => {
            const media = document.getElementById('music');
            window.__maxT = Math.max(window.__maxT || 0, media.currentTime);
            return window.__maxT > media.duration - 0.3 && media.currentTime < 1.5 && !media.paused;
        },
        null,
        needMs,
        'element loop boundary'
    );
    const after = await snapshot(page);
    assert(after.longCount === 0, 'element loop started a buffer source');
    assert(after.audioElements === 1, 'element loop duplicated the media element (' + after.audioElements + ')');
    assert(after.elementPaused === false, 'element stopped at the loop boundary');
    return { duration: plan.duration, rate: plan.rate, level: 'element' };
}

async function crossBufferLoop(page) {
    const plan = await page.evaluate(() => {
        const spy = window.__audioSpy;
        const src = spy.sources.find((item) => item.buffer && item.buffer.duration > 1 && item.__started);
        const ctx = spy.contexts[0];
        src.playbackRate.value = 16;
        return {
            duration: src.buffer.duration,
            rate: src.playbackRate.value,
            t0: ctx.currentTime,
            count: spy.sources.filter((item) => item.buffer && item.buffer.duration > 1).length,
        };
    });
    const need = plan.duration / plan.rate + 0.35;
    await waitFor(
        page,
        (expected) => window.__audioSpy.contexts[0].currentTime - expected.t0 > expected.need,
        { t0: plan.t0, need },
        Math.ceil(need * 1000) + 20000,
        'loop boundary'
    );
    const level = await expectLevel(page, 3, 2000);
    const after = await snapshot(page);
    assert(after.longCount === plan.count, 'loop created another source (' + after.longCount + ' from ' + plan.count + ')');
    assert(after.longCount === 1, 'expected a single music source');
    assert(after.loop === true, 'source.loop is not set');
    assert(after.state === 'running', 'context stopped at loop boundary (' + after.state + ')');
    assert(level >= 3, 'silent after loop boundary (level ' + level + ')');
    return { duration: plan.duration, rate: plan.rate, level };
}

async function testAllowed(browser, url, expectMode) {
    const { context, page, problems, warnings } = await openPage(browser, url);
    try {
        await waitUntilPlaying(page, 'autoplay start');
        const heard = await expectAudible(page);
        const snap = await snapshot(page);
        assert(snap.hintHidden === true, 'hint visible even though autoplay worked');
        assert(snap.hintShown !== '1', 'hint was shown during autoplay: states=' + snap.audioStates);
        assert(snap.audioState === 'playing', 'state ' + snap.audioState + ' states=' + snap.audioStates);
        assert(!String(snap.audioStates).split(',').includes('blocked'), 'blocked state during autoplay: ' + snap.audioStates);
        if (expectMode) assert(snap.audioMode === expectMode, 'mode ' + snap.audioMode + ' expected ' + expectMode);
        if (snap.audioMode === 'buffer') {
            assert(snap.longCount === 1, 'expected 1 source, got ' + snap.longCount);
            assert(snap.loop === true, 'loop flag missing');
            assert(snap.elementPaused !== false, 'media element is also playing');
            const t0 = snap.currentTime;
            await page.waitForTimeout(400);
            const later = await snapshot(page);
            assert(later.currentTime > t0 + 0.2, 'context clock did not advance (' + t0 + ' -> ' + later.currentTime + ')');
        } else {
            assert(snap.longCount === 0, 'element mode also started a buffer (' + snap.longCount + ')');
            assert(snap.elementPaused === false, 'element paused');
            assert(snap.audioElements === 1, 'expected one media element, got ' + snap.audioElements);
        }
        assert(problems.length === 0, 'console/page errors: ' + problems.join(' | '));
        const loop = await crossLoopBoundary(page);
        assert(problems.length === 0, 'errors after loop: ' + problems.join(' | '));
        log('  PASS started on load via ' + snap.audioMode + ', hint stayed hidden, signal ' + (heard.level == null ? 'element clock' : 'level ' + heard.level));
        log('  PASS single loop, duration ' + loop.duration.toFixed(3) + 's, crossed one loop at ' + loop.rate + 'x, signal ' + loop.level);
        log('  PASS no console errors' + (warnings.length ? ' (' + warnings.length + ' browser warning(s))' : ''));
    } finally {
        await context.close();
    }
}

async function testBlocked(browser, url, screenshot, expectMode) {
    async function run(interaction, label, shot) {
        const { context, page, problems, warnings } = await openPage(browser, url);
        try {
            await waitFor(
                page,
                () => {
                    const hint = document.getElementById('play-hint');
                    return !!(hint && !hint.hidden);
                },
                null,
                5000,
                'hint'
            );
            await waitFor(
                page,
                () => document.documentElement.dataset.audioReady === '1',
                null,
                15000,
                'decode'
            );
            const before = await snapshot(page);
            assert(before.hintHidden === false, 'hint hidden while blocked');
            assert(before.hintText === 'tap to play', 'hint text "' + before.hintText + '"');
            assert(before.audioState === 'blocked', 'state ' + before.audioState);
            assert(before.startedLong === 0, 'audio started before a gesture (' + before.startedLong + ')');
            assert(before.elementPaused !== false, 'media element already playing');
            assert(before.state === 'suspended' || before.state === 'interrupted' || before.state === null, 'context ' + before.state);
            const t0 = before.currentTime;
            await page.waitForTimeout(350);
            const frozen = await snapshot(page);
            assert(frozen.currentTime - t0 < 0.15, 'clock advanced while blocked (' + (frozen.currentTime - t0) + ')');
            assert(problems.length === 0, 'errors while blocked: ' + problems.join(' | '));
            if (shot) {
                await page.waitForFunction(() => {
                    const img = document.getElementById('leekspin');
                    return img && img.complete && img.naturalWidth > 0;
                }, null, { timeout: 15000 }).catch(() => {});
                await page.screenshot({ path: shot });
                log('  saved ' + shot);
            }
            if (interaction === 'click') await page.click('body', { position: { x: 30, y: 30 } });
            else await page.keyboard.press('KeyA');
            await waitUntilPlaying(page, label + ' start');
            const heard = await expectAudible(page);
            const after = await snapshot(page);
            assert(after.hintHidden === true, 'hint stayed after ' + label);
            assert(after.audioState === 'playing', 'state after ' + label + ' is ' + after.audioState);
            if (expectMode) assert(after.audioMode === expectMode, label + ' mode ' + after.audioMode + ' expected ' + expectMode);
            if (after.audioMode === 'buffer') {
                assert(after.startedLong === 1, label + ' started ' + after.startedLong + ' sources');
                assert(after.longCount === 1, label + ' created ' + after.longCount + ' sources');
                assert(after.loop === true, 'loop flag missing after ' + label);
                assert(after.elementPaused !== false, 'media element still playing beside the buffer');
            } else {
                assert(after.longCount === 0, label + ' also started a buffer (' + after.longCount + ')');
                assert(after.audioElements === 1, 'expected one media element');
                assert(after.elementPaused === false, 'element paused after ' + label);
            }
            const countBeforeRepeat = after.longCount;
            for (let i = 0; i < 4; i++) await page.click('#leekspin', { force: true });
            await page.waitForTimeout(250);
            const repeated = await snapshot(page);
            assert(repeated.longCount === countBeforeRepeat, 'repeated clicks changed source count to ' + repeated.longCount);
            assert(repeated.audioElements === after.audioElements, 'repeated clicks changed element count to ' + repeated.audioElements);
            assert(repeated.hintHidden === true, 'hint returned after repeated clicks');
            assert(repeated.audioState === 'playing', 'repeated clicks stopped audio (' + repeated.audioState + ')');
            const again = await expectAudible(page);
            assert(problems.length === 0, 'errors after ' + label + ': ' + problems.join(' | '));
            if (warnings.length) log('  note ' + warnings.length + ' browser warning(s) while blocked, first: ' + warnings[0].slice(0, 180));
            log('  PASS ' + label + ' starts ' + after.audioMode + ' audio, hint hides, signal ' + (heard.level == null ? 'element clock' : 'level ' + heard.level) + '; still a single player after repeated clicks (' + (again.level == null ? 'clock' : 'level ' + again.level) + ')');
        } finally {
            await context.close();
        }
    }

    await run('click', 'click', screenshot);
    await run('key', 'keypress', null);
}

async function testElementRecovery(page, problems) {
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.getElementById('music').pause();
    });
    await page.waitForTimeout(250);
    const hidden = await snapshot(page);
    assert(hidden.elementPaused === true, 'element kept playing while hidden');
    assert(hidden.longCount === 0, 'element recovery created a buffer');
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(
        page,
        () => {
            const media = document.getElementById('music');
            return !!(media && !media.paused);
        },
        null,
        5000,
        'element resume'
    );
    const heard = await expectAudible(page);
    const after = await snapshot(page);
    assert(after.audioElements === 1, 'resume duplicated the element');
    assert(after.longCount === 0, 'resume started a buffer');
    assert(problems.length === 0, 'errors during element recovery: ' + problems.join(' | '));
    log('  PASS element pauses while hidden and resumes when visible (' + (heard.level == null ? 'clock' : 'level ' + heard.level) + ')');
}

async function testRecovery(browser, url) {
    const { context, page, problems } = await openPage(browser, url);
    try {
        await waitUntilPlaying(page, 'recovery setup');
        const mode = await page.evaluate(() => document.documentElement.dataset.audioMode || '');
        if (mode === 'element') {
            await testElementRecovery(page, problems);
            return;
        }
        await expectLevel(page, 3, 3000);
        const before = await snapshot(page);
        await page.evaluate(async () => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            document.dispatchEvent(new Event('visibilitychange'));
            await window.__audioSpy.contexts[0].suspend();
        });
        await page.waitForTimeout(300);
        const hidden = await snapshot(page);
        assert(hidden.state === 'suspended', 'expected suspend while hidden, got ' + hidden.state);
        assert(hidden.longCount === 1, 'suspend created sources (' + hidden.longCount + ')');
        await page.evaluate(() => {
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await waitFor(
            page,
            () => window.__audioSpy.contexts[0].state === 'running',
            null,
            5000,
            'resume after visible'
        );
        const level = await expectLevel(page, 3, 3000);
        const after = await snapshot(page);
        assert(after.longCount === before.longCount, 'recovery changed source count to ' + after.longCount);
        assert(after.startedLong === 1, 'recovery started ' + after.startedLong);
        assert(level >= 3, 'silent after resume (level ' + level + ')');

        // Visible interruption: suspend() while the page is showing. The
        // statechange handler should resume the same node without a new tap.
        await page.evaluate(() => window.__audioSpy.contexts[0].suspend());
        await waitFor(
            page,
            () => window.__audioSpy.contexts[0].state === 'running',
            null,
            5000,
            'resume after visible interruption'
        );
        const level2 = await expectLevel(page, 3, 3000);
        const recovered = await snapshot(page);
        assert(recovered.longCount === 1, 'visible interruption duplicated audio (' + recovered.longCount + ')');
        assert(level2 >= 3, 'silent after visible interruption (level ' + level2 + ')');
        assert(problems.length === 0, 'errors during recovery: ' + problems.join(' | '));
        log('  PASS hidden suspend stays suspended; visible again resumes the same source (level ' + level + ')');
        log('  PASS visible interruption resumes without a second source (level ' + level2 + ')');
    } finally {
        await context.close();
    }
}

async function runBrowser(name, launch, url, modes) {
    log('');
    log('== ' + name + ' ==');
    let browser;
    try {
        browser = await launch();
    } catch (err) {
        const message = err && err.message ? err.message.split('\n')[0] : String(err);
        log('  SKIP launch failed: ' + message);
        return false;
    }
    try {
        if (modes.allowed) {
            log('-- autoplay allowed --');
            await testAllowed(browser, url, modes.expectAllowed || null);
        }
        if (modes.blocked) {
            log('-- autoplay blocked --');
            await testBlocked(browser, url, modes.screenshot || null, modes.expectBlocked || null);
        }
        if (modes.recovery) {
            log('-- interruption recovery --');
            await testRecovery(browser, url);
        }
        log('RESULT ' + name + ' PASS');
        return true;
    } finally {
        await browser.close();
    }
}

const artifactDir = '/opt/cursor/artifacts';
const screenshotPath = join(artifactDir, 'blocked_autoplay_hint.png');
const logPath = join(artifactDir, 'playback_test_log.txt');

async function webkitMediaPlaybackCrashes() {
    let browser;
    try {
        browser = await webkit.launch({ headless: true });
    } catch (err) {
        return { launchError: err && err.message ? err.message.split('\n')[0] : String(err) };
    }
    const page = await browser.newPage();
    let crashed = false;
    page.on('crash', () => { crashed = true; });
    try {
        await page.goto('about:blank');
        await page.evaluate(() => {
            const rate = 8000;
            const length = rate / 2;
            const bytes = 44 + length * 2;
            const buffer = new ArrayBuffer(bytes);
            const view = new DataView(buffer);
            const write = (offset, text) => {
                for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
            };
            write(0, 'RIFF');
            view.setUint32(4, bytes - 8, true);
            write(8, 'WAVE');
            write(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true);
            view.setUint16(22, 1, true);
            view.setUint32(24, rate, true);
            view.setUint32(28, rate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            write(36, 'data');
            view.setUint32(40, length * 2, true);
            for (let i = 0; i < length; i++) view.setInt16(44 + i * 2, Math.sin(i / 8) * 4000, true);
            const audio = new Audio(URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' })));
            const pending = audio.play();
            if (pending && pending.catch) pending.catch(() => {});
        });
        await page.waitForTimeout(800);
    } catch (err) {
        crashed = true;
    }
    await browser.close().catch(() => {});
    return { crashed };
}

const only = process.env.ONLY || '';
function selected(name) {
    return !only || name.toLowerCase().includes(only.toLowerCase());
}

const { server, url } = await startServer();
log('serving ' + url);
let failed = false;
try {
    if (selected('chromium allowed')) await runBrowser(
        'chromium allowed (--autoplay-policy=no-user-gesture-required)',
        () => chromium.launch({
            channel: 'chrome',
            headless: true,
            args: ['--autoplay-policy=no-user-gesture-required'],
        }),
        url,
        { allowed: true, recovery: true, expectAllowed: 'buffer' }
    );
    if (selected('chromium blocked')) await runBrowser(
        'chromium blocked (--autoplay-policy=document-user-activation-required)',
        () => chromium.launch({
            channel: 'chrome',
            headless: true,
            args: ['--autoplay-policy=document-user-activation-required'],
        }),
        url,
        { blocked: true, screenshot: screenshotPath, expectBlocked: 'buffer' }
    );

    const firefoxAllowed = {
        'media.autoplay.default': 0,
        'media.autoplay.block-webaudio': false,
        'media.autoplay.blocking_policy': 0,
        'media.autoplay.enabled.user-gestures-needed': false,
    };
    const firefoxBlocked = {
        'media.autoplay.default': 1,
        'media.autoplay.block-webaudio': true,
        'media.autoplay.blocking_policy': 1,
        'media.autoplay.enabled.user-gestures-needed': true,
    };
    if (selected('firefox allowed')) await runBrowser(
        'firefox allowed (media.autoplay.default=0, block-webaudio=false)',
        () => firefox.launch({ headless: true, firefoxUserPrefs: firefoxAllowed }),
        url,
        { allowed: true, recovery: true, expectAllowed: 'element' }
    );
    if (selected('firefox blocked')) await runBrowser(
        'firefox blocked (media.autoplay.default=1, block-webaudio=true)',
        () => firefox.launch({ headless: true, firefoxUserPrefs: firefoxBlocked }),
        url,
        { blocked: true, expectBlocked: 'element' }
    );
    if (selected('webkit')) {
        const webkitMedia = await webkitMediaPlaybackCrashes();
        if (webkitMedia.launchError || webkitMedia.crashed) {
            log('');
            log('== webkit ==');
            if (webkitMedia.launchError) {
                log('  SKIP launch failed: ' + webkitMedia.launchError);
            } else {
                log('  SKIP Playwright WebKit crashes the renderer inside HTMLMediaElement.play().');
                log('  Reproduced with a generated half-second WAV that never loads this page, so the');
                log('  allowed and blocked checks cannot be completed in this build. decodeAudioData()');
                log('  on leekspin.mp3 also rejects with EncodingError here.');
            }
        } else {
            if (selected('webkit allowed')) await runBrowser(
                'webkit allowed',
                () => webkit.launch({ headless: true }),
                url,
                { allowed: true, recovery: true }
            );
            if (selected('webkit blocked')) await runBrowser(
                'webkit blocked',
                () => webkit.launch({ headless: true }),
                url,
                { blocked: true }
            );
        }
    }
} catch (err) {
    failed = true;
    log('FAIL ' + (err && err.stack ? err.stack : err));
} finally {
    await new Promise((resolve) => server.close(resolve));
}

log('');
log(failed ? 'OVERALL FAIL' : 'OVERALL PASS');
await mkdir(artifactDir, { recursive: true });
if (!failed) {
    await writeFile(logPath, lines.join('\n') + '\n');
    log('wrote ' + logPath);
}
process.exitCode = failed ? 1 : 0;
