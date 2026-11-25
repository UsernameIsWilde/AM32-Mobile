// Adapts a checkout of am32-firmware/am32-configurator for the Android build.
//
//   node scripts/patch-web.mjs <path-to-checkout>
//
// The changes are deliberately small, the app itself is used as is:
//   - no PWA / service worker: the APK already is the installed copy, and a service worker
//     inside a WebView would bypass the request interception the app relies on
//   - no Matomo analytics: the bundled UI talks to nothing but the app's own content layer
//   - icons are compiled into the bundle; upstream downloads them from the Iconify web
//     API at runtime
//   - Connect ignores further taps while an attempt is running and shows a spinner
//   - a firmware download that fails (no network on a phone is normal) is reported and
//     the flash dialog is released, instead of the error text being treated as firmware
//   - no server code (API routes, database, admin pages): the app answers /api itself
//   - no type check during the build: it only slows the build down here
//
// Every edit asserts that the text it replaces is still there, so an upstream change
// fails the build loudly instead of silently producing something else.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2] || !existsSync(join(root, 'nuxt.config.ts'))) {
    console.error('usage: node patch-web.mjs <am32-configurator checkout>');
    process.exit(1);
}

// replacements: [pattern, replacement, expected number of matches (default 1)]
function edit (file, replacements) {
    const path = join(root, file);
    let text = readFileSync(path, 'utf8');
    for (const [pattern, replacement, expected = 1] of replacements) {
        const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
        const found = (text.match(global) ?? []).length;
        if (found !== expected) {
            throw new Error(`${file}: ${pattern} matched ${found} time(s), expected ${expected} - upstream changed, update patch-web.mjs`);
        }
        text = text.replace(global, replacement);
    }
    writeFileSync(path, text);
    console.log(`patched ${file}`);
}

edit('nuxt.config.ts', [
    [/[ \t]*'@vite-pwa\/nuxt',\r?\n/, ''],
    [/typeCheck: true/, 'typeCheck: false'],
    [/devtools: \{\s*enabled: true/, 'devtools: {\n        enabled: false']
]);

edit('app.vue', [
    [/[ \t]*<NuxtPwaManifest \/>\r?\n/, ''],
    [/\$pwa\.offlineReady/, '$pwa?.offlineReady'],
    [/\$pwa\.needRefresh/, '$pwa?.needRefresh']
]);

const matomo = join(root, 'plugins', 'matomo.ts');
if (!existsSync(matomo)) {
    throw new Error('plugins/matomo.ts is gone - upstream changed, update patch-web.mjs');
}
rmSync(matomo);
console.log('removed plugins/matomo.ts');

// --- server side ------------------------------------------------------------------------
// The API routes, the database layer and the admin pages belong to the am32.ca server; in
// the app LocalContent.kt answers /api/... instead. They also have to go for a practical
// reason: the Prisma client they pull into the prerender bundle crashes it on Windows.
for (const dir of ['server', join('pages', 'admin')]) {
    const path = join(root, dir);
    if (!existsSync(path)) {
        throw new Error(`${dir} is gone - upstream changed, update patch-web.mjs`);
    }
    rmSync(path, { recursive: true });
    console.log(`removed ${dir}`);
}

// --- icons ------------------------------------------------------------------------------
// Every <UIcon> is rendered by @nuxt/icon, which in a static build downloads the icon data
// from https://api.iconify.design the first time an icon is shown. The app lets the page
// reach no host but its own, and must show its icons without a network, so they are
// compiled into the bundle instead: the ones found by scanning the sources, plus the ones
// a scan cannot see (defaults inside the UI library, and names built at runtime).
const extraIcons = [
    // @nuxt/ui component defaults (dist/runtime/ui.config)
    ...[
        'arrow-path-20-solid', 'arrows-up-down-20-solid', 'bars-arrow-down-20-solid', 'bars-arrow-up-20-solid',
        'check-20-solid', 'chevron-double-left-20-solid', 'chevron-double-right-20-solid', 'chevron-down',
        'chevron-down-20-solid', 'chevron-left-20-solid', 'chevron-right-20-solid', 'circle-stack-20-solid',
        'magnifying-glass-20-solid', 'minus-20-solid', 'x-mark-20-solid'
    ].map(name => `heroicons:${name}`),
    // the ESC number badge: `i-material-symbols-counter-${n}-outline` in EscView.vue
    ...Array.from({ length: 8 }, (_, i) => `material-symbols:counter-${i + 1}-outline`)
];
edit('nuxt.config.ts', [
    [
        /( *)compatibilityDate:/,
        [
            '$1icon: {',
            "$1    provider: 'none',",
            '$1    clientBundle: {',
            '$1        scan: true,',
            `$1        icons: ${JSON.stringify(extraIcons)},`,
            '$1        sizeLimitKb: 1024',
            '$1    }',
            '$1},',
            '',
            '$1compatibilityDate:'
        ].join('\n')
    ]
]);

// --- one connection attempt at a time ---------------------------------------------------
// Connecting can take a while: when the flight controller was left in 4-way mode, upstream
// spends up to ~50 seconds retrying, with the Connect button still active. A second tap
// starts a second attempt on the same port, and when the first one finally gives up it
// closes the connection the second one established. On a phone, where nothing shows that
// an attempt is running, that second tap is the natural thing to do. So: ignore taps
// while connecting and show a spinner on the button.
edit('components/SerialDevice.vue', [
    [
        /<UButton v-if="!serialStore\.hasConnection" :disabled="serialStore\.selectedDevice\.id === '-1'" size="2xs" @click="connectToDevice">/,
        '<UButton v-if="!serialStore.hasConnection" :disabled="serialStore.selectedDevice.id === \'-1\' || isConnecting" :loading="isConnecting" size="2xs" @click="connectToDevice">'
    ],
    [
        /const connectToDevice = async \(\) => \{\r?\n/,
        [
            'const isConnecting = ref(false);',
            'const connectToDevice = async () => {',
            '    if (isConnecting.value) {',
            '        return;',
            '    }',
            '    isConnecting.value = true;',
            '    try {',
            '        await connectToDeviceNow();',
            '    } finally {',
            '        isConnecting.value = false;',
            '    }',
            '};',
            '',
            'const connectToDeviceNow = async () => {',
            ''
        ].join('\n')
    ]
]);

// --- firmware download ------------------------------------------------------------------
// Upstream neither checks the HTTP status nor catches a failed request: an error body would
// be stored as "the firmware" for that URL and handed to the flasher, and a rejected fetch
// leaves the dialog locked in its "flashing" state.
edit('components/SerialDevice.vue', [
    [
        /( *)const file: Response = await fetch\(url\);\r?\n/,
        [
            '$1const file: Response | null = await fetch(url).catch(() => null);',
            '$1if (!file || !file.ok) {',
            '$1    escStore.activeTarget = -1;',
            "$1    escStore.step = '';",
            "$1    logError('Firmware download failed');",
            '$1    toast.add({',
            "$1        icon: 'i-material-symbols-error',",
            "$1        title: 'Error',",
            "$1        color: 'red',",
            "$1        description: 'Firmware download failed. Check the internet connection and try again.'",
            '$1    });',
            '$1    return;',
            '$1}',
            ''
        ].join('\n')
    ]
]);
