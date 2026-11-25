// End-to-end check of the web app that goes into the APK, in a headless desktop browser
// emulating a phone screen: the real configurator + bridge.js + mobile.css + a mock USB
// flight controller with four ESCs (tests/mock-native.js).
//
//   node tests/e2e-test.mjs [screenshot-dir]
//
// Needs the built web app (android/app/src/main/assets/www) and internet access (the
// firmware list is fetched from am32.ca). With a screenshot dir it also saves phone sized
// screenshots: the three pages, and the settings form after the ESCs have been read.
//
// What it cannot cover: the Kotlin side (WebView request interception, real USB).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPreviewServer } from './preview-server.mjs';

// The browser is driven over the DevTools protocol, which needs a WebSocket client.
// Node 20 has one behind a flag: restart with it when it is missing.
if (typeof WebSocket === 'undefined') {
    const again = spawnSync(process.execPath, ['--experimental-websocket', ...process.argv.slice(1)], { stdio: 'inherit' });
    process.exit(again.status ?? 1);
}

const here = dirname(fileURLToPath(import.meta.url));
const PHONE = { width: 412, height: 915, deviceScaleFactor: 2, mobile: true };
const SLICE = 1200; // CSS pixels of page per screenshot file

const browserPath = [
    process.env.BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(path => path && existsSync(path));
if (!browserPath) {
    console.error('No Chrome or Edge found. Set BROWSER to the executable.');
    process.exit(2);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => null)]);

// --- a minimal DevTools protocol client ---------------------------------------------------
async function openBrowser () {
    const profile = mkdtempSync(join(tmpdir(), 'am32-e2e-'));
    const child = spawn(browserPath, [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
        // like the app's WebView: no host but our own is reachable from the page
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
        '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'
    ], { stdio: 'ignore' });

    // the browser writes the port it picked into its profile folder
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(portFile); i++) {
        await sleep(100);
    }
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve);
        socket.addEventListener('error', reject);
    });

    let nextId = 1;
    const pending = new Map();
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        const waiter = pending.get(message.id);
        if (waiter) {
            pending.delete(message.id);
            message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
        }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });

    await send('Emulation.setDeviceMetricsOverride', PHONE);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });

    return {
        send,
        async close () {
            socket.close();
            child.kill();
            await sleep(500);
            try {
                rmSync(profile, { recursive: true, force: true });
            } catch { /* the browser may still hold a file for a moment */ }
        }
    };
}

// the whole page, top to bottom, in files of SLICE pixels each
async function screenshot (browser, directory, name) {
    const { result } = await browser.send('Runtime.evaluate', { expression: 'document.documentElement.scrollHeight' });
    const height = result.value;
    const parts = Math.ceil(height / SLICE);
    for (let part = 0; part < parts; part++) {
        const clip = { x: 0, y: part * SLICE, width: PHONE.width, height: Math.min(SLICE, height - part * SLICE), scale: 1 };
        const { data } = await browser.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
        const file = join(directory, parts === 1 ? `${name}.png` : `${name}-${part + 1}.png`);
        writeFileSync(file, Buffer.from(data, 'base64'));
        console.log(`saved  ${file}`);
    }
}

// --- run ----------------------------------------------------------------------------------
const waiting = {};
const message = kind => new Promise((resolve) => { waiting[kind] = resolve; });
const { server, url } = await startPreviewServer({
    extraScripts: [join(here, 'e2e-page.js')],
    onMessage: (kind, body) => waiting[kind]?.(body)
});

const browser = await openBrowser();
let results = null;
try {
    // the scripted scenario: connect, read the ESCs, check the layout, disconnect
    const reported = message('result');
    await browser.send('Page.navigate', { url: `${url}/configurator?e2e` });
    results = await within(reported, 180000);

    const shots = process.argv[2] ? resolve(process.argv[2]) : null;
    if (shots) {
        mkdirSync(shots, { recursive: true });
        for (const [name, path] of [['home', '/'], ['downloads', '/downloads']]) {
            await browser.send('Page.navigate', { url: url + path });
            await sleep(4000);
            await screenshot(browser, shots, name);
        }
        // Views that only exist with ESCs connected: the page connects, reads the mock
        // ESCs, opens the view and says when it is on screen.
        for (const view of ['settings', 'tune', 'flash']) {
            const ready = message('ready');
            await browser.send('Page.navigate', { url: `${url}/configurator?shot=${view}` });
            if (await within(ready, 120000)) {
                await sleep(500);
                await screenshot(browser, shots, view);
            } else {
                console.log(`FAILED  the ${view} view did not become ready for a screenshot`);
            }
        }
    }
} finally {
    await browser.close();
    server.close();
}

if (!results) {
    console.error('The page did not report back within 3 minutes.');
    process.exit(1);
}
let failed = 0;
for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.info ? `: ${result.info}` : ''}`);
    if (!result.ok) {
        failed++;
        console.log(`      ${JSON.stringify(result.detail)}`);
    }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
