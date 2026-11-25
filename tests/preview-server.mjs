// Serves the web app that is packed into the APK to a desktop browser, wired up the way
// the Android app wires it: bridge.js injected into every page, a mock USB device behind
// it (tests/mock-native.js), /api answered from am32.ca.
//
//   node tests/preview-server.mjs [port]         then open http://127.0.0.1:<port>/
//
// It is a development aid: it mirrors what LocalContent.kt does but does not run it, and
// it keeps no offline cache.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(here, '..');
const www = join(project, 'android', 'app', 'src', 'main', 'assets', 'www');
const bridge = join(project, 'android', 'app', 'src', 'main', 'assets', 'bridge', 'bridge.js');

const REMOTE = 'https://am32.ca';
const SECTIONS = ['releases', 'kiss-ultra-releases', 'bootloader'];
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm',
    '.txt': 'text/plain', '.bin': 'application/octet-stream'
};

/**
 * @param {{ port?: number, extraScripts?: string[], onMessage?: (kind: string, body: unknown) => void }} options
 * extraScripts: files injected after the bridge (the end-to-end test uses this).
 */
export async function startPreviewServer ({ port = 0, extraScripts = [], onMessage } = {}) {
    if (!existsSync(join(www, 'index.html'))) {
        throw new Error(`No web app in ${www}. Run scripts\\build-web.ps1 first.`);
    }
    const injected = {
        '/__android/mock-native.js': join(here, 'mock-native.js'),
        '/__android/bridge.js': bridge
    };
    extraScripts.forEach((file, index) => { injected[`/__android/extra-${index}.js`] = file; });
    const tags = Object.keys(injected).map(path => `<script src="${path}"></script>`).join('') +
        '<link rel="stylesheet" href="/__android/mobile.css">';
    injected['/__android/mobile.css'] = join(dirname(bridge), 'mobile.css');

    const send = (response, status, type, body) => {
        response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        response.end(body);
    };

    const sendFile = (response, file) => {
        const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
        let body = readFileSync(file);
        if (type.startsWith('text/html')) {
            body = body.toString('utf8').replace(/<head[^>]*>/i, match => match + tags);
        }
        send(response, 200, type, body);
    };

    const proxy = async (response, path) => {
        try {
            const remote = await fetch(REMOTE + path, { signal: AbortSignal.timeout(30000) });
            send(response, remote.status, remote.headers.get('content-type') ?? 'application/octet-stream',
                Buffer.from(await remote.arrayBuffer()));
        } catch {
            send(response, 504, 'text/plain', 'Offline');
        }
    };

    // same rules as LocalContent.listFiles
    const listFiles = async (response, url) => {
        try {
            const remote = await fetch(`${REMOTE}/api/files?prereleases`, { signal: AbortSignal.timeout(30000) });
            const wanted = url.searchParams.get('filter')?.split(',');
            const prereleases = url.searchParams.has('prereleases');
            const data = (await remote.json()).data
                .filter(section => SECTIONS.includes(section.name) && (!wanted || wanted.includes(section.name)))
                .map(section => (section.name === 'releases' && !prereleases
                    ? { ...section, children: section.children.filter(child => !child.name.endsWith('-rc')) }
                    : section));
            send(response, 200, 'application/json', JSON.stringify({ data }));
        } catch {
            send(response, 200, 'application/json', JSON.stringify({ data: [] }));
        }
    };

    const server = createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const path = decodeURIComponent(url.pathname);

        // the test page reports back: POST /__android/result (test results), .../ready
        if (request.method === 'POST' && (path === '/__android/result' || path === '/__android/ready')) {
            let body = '';
            request.on('data', (chunk) => { body += chunk; });
            request.on('end', () => {
                response.end('ok');
                onMessage?.(path.split('/').pop(), JSON.parse(body || 'true'));
            });
            return;
        }
        if (injected[path]) {
            return sendFile(response, injected[path]);
        }
        // A phone sized frame around a page: a desktop browser window cannot be made
        // narrower than about 500px, an iframe can.   /__android/phone?src=/configurator
        if (path === '/__android/phone') {
            const width = Number(url.searchParams.get('width')) || 412;
            const height = Number(url.searchParams.get('height')) || 915;
            const src = (url.searchParams.get('src') || '/').replace(/"/g, '');
            // offset: how far the page is scrolled up, to photograph a long page in pieces
            const offset = Number(url.searchParams.get('offset')) || 0;
            return send(response, 200, 'text/html; charset=utf-8',
                '<!DOCTYPE html><html><body style="margin:0;background:#222;overflow:hidden">' +
                `<iframe src="${src}" width="${width}" height="${height}" ` +
                `style="border:0;display:block;margin-top:-${offset}px"></iframe></body></html>`);
        }
        if (path === '/api/files') {
            return void listFiles(response, url);
        }
        if (path.startsWith('/api/') || path.startsWith('/uploads/') || path === '/eeprom') {
            return void proxy(response, url.pathname + url.search);
        }

        const file = normalize(join(www, path));
        if (file !== www && !file.startsWith(www + sep)) {
            return send(response, 400, 'text/plain', 'Bad Request');
        }
        if (existsSync(file) && statSync(file).isFile()) {
            return sendFile(response, file);
        }
        if (existsSync(join(file, 'index.html'))) {
            return sendFile(response, join(file, 'index.html'));
        }
        if (path.split('/').pop().includes('.')) {
            return send(response, 404, 'text/plain', 'Not Found');
        }
        sendFile(response, join(www, existsSync(join(www, '200.html')) ? '200.html' : 'index.html'));
    });

    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { url } = await startPreviewServer({ port: Number(process.argv[2]) || 5173 });
    console.log(`AM32 preview with a mock USB flight controller: ${url}/`);
}
