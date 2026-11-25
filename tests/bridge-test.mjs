// Runs tests/bridge-test.html in a headless browser.
//
//   node tests/bridge-test.mjs <configurator checkout with node_modules>
//
// bridge.js (the navigator.serial polyfill the app injects) is exercised with the real
// webserial-wrapper and @am32/serial-msp libraries the configurator uses, against a fake
// native USB layer. It covers the JavaScript half of the USB bridge; the Kotlin half needs
// a phone and a real device.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const webSrc = resolve(process.argv[2] ?? '');
const modules = join(webSrc, 'node_modules');

const routes = {
    '/': join(here, 'bridge-test.html'),
    '/bridge.js': join(project, 'android', 'app', 'src', 'main', 'assets', 'bridge', 'bridge.js'),
    '/lib/webserial-wrapper.js': join(modules, 'webserial-wrapper', 'dist', 'serialstream.esm.js')
};
const serialMsp = join(modules, '@am32', 'serial-msp', 'dist');

if (!process.argv[2] || !existsSync(routes['/lib/webserial-wrapper.js']) || !existsSync(serialMsp)) {
    console.error('usage: node tests/bridge-test.mjs <configurator checkout with node_modules>');
    process.exit(2);
}

const browser = [
    process.env.BROWSER,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(path => path && existsSync(path));
if (!browser) {
    console.error('No Chrome or Edge found. Set BROWSER to the executable.');
    process.exit(2);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };

function fileFor (path) {
    if (routes[path]) {
        return routes[path];
    }
    const prefix = '/lib/serial-msp/';
    if (path.startsWith(prefix)) {
        const file = normalize(join(serialMsp, path.slice(prefix.length)));
        return file.startsWith(serialMsp + sep) ? file : null;
    }
    return null;
}

let finish;
const finished = new Promise((resolve) => { finish = resolve; });

const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'POST' && path === '/result') {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
            response.end('ok');
            finish(JSON.parse(body));
        });
        return;
    }
    const file = fileFor(path);
    if (!file || !existsSync(file)) {
        response.writeHead(404).end('not found');
        return;
    }
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(readFileSync(file));
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const profile = mkdtempSync(join(tmpdir(), 'am32-bridge-test-'));
const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, url
], { stdio: 'ignore' });

const timeout = new Promise(resolve => setTimeout(() => resolve(null), 60000));
const results = await Promise.race([finished, timeout]);

child.kill();
server.close();
await new Promise(resolve => setTimeout(resolve, 500));
try {
    rmSync(profile, { recursive: true, force: true });
} catch { /* the browser may still hold a file for a moment */ }

if (!results) {
    console.error('The test page did not report back within 60 seconds.');
    process.exit(1);
}

let failed = 0;
for (const result of results) {
    console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}`);
    if (!result.ok) {
        failed++;
        console.log(`      ${JSON.stringify(result.detail)}`);
    }
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
