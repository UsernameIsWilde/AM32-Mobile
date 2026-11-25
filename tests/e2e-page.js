/*
 * Injected by tests/e2e-test.mjs into the real configurator page. Drives the UI the way a
 * user would (Port select -> Connect -> Disconnect) against the mock flight controller in
 * mock-native.js and reports what happened.
 */
(function () {
    'use strict';

    // ?e2e   run the whole scenario and report
    // ?shot  connect, read the ESCs and stay there (for screenshots)
    var query = location.search;
    var shotOnly = query.includes('shot');
    if (!location.pathname.startsWith('/configurator') || !(query.includes('e2e') || shotOnly)) {
        return;
    }

    var results = [];
    var check = function (name, ok, detail) {
        results.push({ name: name, ok: !!ok, detail: ok ? undefined : detail });
    };
    var button = function (label) {
        return Array.prototype.find.call(document.querySelectorAll('button'), function (b) {
            return b.textContent.trim() === label;
        });
    };
    var until = function (condition, ms) {
        return new Promise(function (resolve) {
            var started = Date.now();
            (function poll () {
                var value;
                try { value = condition(); } catch (e) { value = null; }
                if (value) { return resolve(value); }
                if (Date.now() - started > ms) { return resolve(null); }
                setTimeout(poll, 100);
            })();
        });
    };
    // @nuxt/icon draws an icon as a CSS mask (or background) whose image is the icon's SVG.
    // An icon whose data is missing is an empty box: that is what would happen in the app
    // if an icon were not compiled into the bundle.
    var checkIcons = function (state) {
        var icons = Array.prototype.slice.call(document.querySelectorAll('.iconify'));
        var missing = icons.filter(function (icon) {
            if (icon.tagName.toLowerCase() === 'svg') {
                return icon.childElementCount === 0;
            }
            var style = getComputedStyle(icon);
            return ![style.maskImage, style.webkitMaskImage, style.backgroundImage].some(function (value) {
                return value && value.indexOf('url(') >= 0;
            });
        }).map(function (icon) { return icon.getAttribute('class'); });
        check('all ' + icons.length + ' icons are drawn (' + state + ')', icons.length > 0 && missing.length === 0, missing);
    };
    var overlap = function (a, b) {
        var w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        var h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return w > 1 && h > 1;
    };
    var textRect = function (element) {
        var range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect();
    };
    var short = function (element) {
        return element.textContent.trim().replace(/\s+/g, ' ').slice(0, 30);
    };
    // The settings form on a phone: nothing may run off the screen, the per-ESC status
    // dots must not sit on top of a label, and neighbouring fields must not run into
    // each other.
    var checkLayout = function () {
        check('the page is not wider than the screen',
            document.documentElement.scrollWidth <= window.innerWidth + 1,
            'viewport ' + window.innerWidth + 'px, content ' + document.documentElement.scrollWidth + 'px');

        var covered = [];
        var dotRows = Array.prototype.slice.call(document.querySelectorAll('[class~="w-[10px]"][class~="rounded-full"]'))
            .map(function (dot) { return dot.parentElement.parentElement; })
            .filter(function (row, index, all) { return all.indexOf(row) === index; });
        dotRows.forEach(function (dots) {
            var label = dots.parentElement.querySelector('label, .mb-1');
            if (label && label.textContent.trim() && overlap(dots.getBoundingClientRect(), textRect(label))) {
                covered.push(short(label));
            }
        });
        check('status dots do not cover a label (' + dotRows.length + ' fields with dots)',
            dotRows.length > 0 && covered.length === 0, covered);

        var collisions = [];
        Array.prototype.forEach.call(document.querySelectorAll('.flex-grow.grid.gap-4.p-4'), function (grid) {
            var cells = Array.prototype.slice.call(grid.children);
            var rects = cells.map(function (cell) {
                // as wide as the widest text inside the cell, even where it spills out
                var box = cell.getBoundingClientRect();
                var right = box.right;
                Array.prototype.forEach.call(cell.querySelectorAll('div, label, span'), function (inner) {
                    if (inner.childElementCount === 0 && inner.textContent.trim()) {
                        right = Math.max(right, textRect(inner).right);
                    }
                });
                return { left: box.left, top: box.top, bottom: box.bottom, right: right };
            });
            for (var i = 0; i < rects.length; i++) {
                for (var j = 0; j < rects.length; j++) {
                    if (i !== j && rects[i].left < rects[j].left && overlap(rects[i], rects[j])) {
                        collisions.push(short(cells[i]) + ' -> ' + short(cells[j]));
                    }
                }
            }
        });
        check('neighbouring fields do not run into each other', collisions.length === 0, collisions);
    };
    var errors = [];
    window.addEventListener('error', function (e) { errors.push(String(e.message)); });
    window.addEventListener('unhandledrejection', function (e) { errors.push(String(e.reason && e.reason.message || e.reason)); });

    (async function () {
        try {
            var portSelect = await until(function () { return button('Port select'); }, 20000);
            check('the configurator renders (Port select button present)', portSelect, document.body.innerText.slice(0, 300));
            check('the page sees navigator.serial', 'serial' in navigator && !document.body.innerText.includes('No WebSerial'));
            check('nothing selectable before a device is granted', button('Connect') && button('Connect').disabled);

            checkIcons('idle');

            portSelect.click();
            var connect = await until(function () { var b = button('Connect'); return b && !b.disabled ? b : null; }, 10000);
            check('the granted device becomes selectable', connect);
            check('the device is listed with its USB ids', document.body.innerText.includes('0x0483:0x5740'), document.body.innerText.slice(0, 200));

            // on a phone the log is the only sign that something is happening
            var logLine = Array.prototype.find.call(document.querySelectorAll('div'), function (d) {
                return d.childElementCount === 0 && d.textContent.trim() === 'initializing...';
            });
            check('the log is visible', logLine && logLine.getBoundingClientRect().height > 0);

            connect.click();
            await new Promise(function (resolve) { setTimeout(resolve, 300); });
            check('Connect cannot be tapped again while connecting', button('Connect') && button('Connect').disabled);
            var disconnect = await until(function () { return button('Disconnect'); }, 30000);
            check('Connect reaches the connected state', disconnect, errors);
            check('the port was opened at 115200 8N1',
                JSON.stringify(mockNative.opened[0]) === JSON.stringify([115200, 8, 1, 'none']), mockNative.opened);
            // API_VERSION, FC_VARIANT, BATTERY_STATE, MOTOR_CONFIG, SET_PASSTHROUGH
            check('all five MSP requests went out and were answered',
                [1, 2, 130, 131, 245].every(function (c) { return mockNative.requests.indexOf(c) >= 0; }), mockNative.requests);
            var text = document.body.textContent;
            check('the replies were parsed (API 1.46, Betaflight, 16.8 V, 4 motors)',
                text.includes('API_VERSION: 1.46.0') && text.includes('TYPE: bf') &&
                text.includes('BATTERY VOLTAGE: 16.8') && text.includes('MOTOR COUNT: 4'),
                text.replace(/\s+/g, ' ').slice(0, 600));

            checkIcons('connected');

            // --- read the four ESCs through the 4-way passthrough ---------------------------
            var read = button('Read');
            check('a Read button is offered once connected', read);
            if (read) {
                read.click();
            }
            var settings = await until(function () {
                return document.body.innerText.includes('Essentials') && !document.querySelector('.animate-pulse');
            }, 60000);
            check('the settings of the ESCs are shown', settings, errors.concat(mockNative.fourWay.slice(-10)));
            var settingsText = document.body.innerText;
            check('all four ESCs were identified (name, firmware version, bootloader pin)',
                (settingsText.match(/AGFRC_V2_F051/g) || []).length === 4 && settingsText.includes('2.22') && settingsText.includes('PB4'),
                settingsText.replace(/\s+/g, ' ').slice(0, 400));
            checkIcons('settings');
            checkLayout();

            // the Tune tab shows the same ESC cards in a different container
            var cardsFit = function () {
                var cards = Array.prototype.slice.call(document.querySelectorAll('.ring-4'));
                var outside = cards.filter(function (card) {
                    var box = card.getBoundingClientRect();
                    return box.width > 0 && (box.left < 0 || box.right > window.innerWidth + 1);
                });
                return cards.length >= 4 && outside.length === 0;
            };
            check('the ESC cards fit the screen (Base tab)', cardsFit());
            if (!shotOnly && button('Tune')) {
                button('Tune').click();
                await new Promise(function (resolve) { setTimeout(resolve, 1500); });
                check('the ESC cards fit the screen (Tune tab)', cardsFit());
                check('the Tune tab is not wider than the screen',
                    document.documentElement.scrollWidth <= window.innerWidth + 1,
                    'content ' + document.documentElement.scrollWidth + 'px');
                checkIcons('tune');
                button('Base').click();
                await new Promise(function (resolve) { setTimeout(resolve, 800); });
            }
            if (shotOnly) {
                // ?shot=tune / ?shot=flash: open that part of the UI as well
                var extra = { tune: 'Tune', flash: 'Flash firmware' }[new URLSearchParams(query).get('shot')];
                if (extra && button(extra)) {
                    button(extra).click();
                    await new Promise(function (resolve) { setTimeout(resolve, 2500); });
                }
                // leave it on screen and say that it is there
                await fetch('/__android/ready', { method: 'POST', body: 'true' });
                return;
            }

            if (disconnect) {
                disconnect.click();
                var back = await until(function () { return button('Connect'); }, 10000);
                check('Disconnect returns to the idle state and closes the port', back && mockNative.closed >= 1, mockNative.closed);
            }

            // firmware listing through /api/files, as the flash dialog requests it
            var listing = await fetch('/api/files?filter=releases').then(function (r) { return r.json(); });
            var releases = listing.data && listing.data[0] && listing.data[0].children || [];
            check('the release list arrives from am32.ca', releases.length > 0 && releases[0].files.length > 0,
                releases.map(function (r) { return r.name; }));
            check('only firmware sections are listed', listing.data.length === 1 && listing.data[0].name === 'releases');

            // the page must not be wider than a phone screen
            results.push({
                name: 'layout width',
                ok: true,
                info: 'viewport ' + window.innerWidth + 'px, content ' + document.documentElement.scrollWidth + 'px'
            });
            // The Android app refuses every request to another host, so the page must not
            // depend on one (upstream: icon data, analytics).
            var foreign = performance.getEntriesByType('resource')
                .map(function (entry) { return entry.name; })
                .filter(function (name) { return /^https?:/.test(name) && name.indexOf(location.origin + '/') !== 0; });
            check('the page requests nothing from other hosts', foreign.length === 0, foreign);
            check('no uncaught errors', errors.length === 0, errors);
        } catch (error) {
            check('test run completed', false, String(error && error.stack || error));
        }
        await fetch('/__android/result', { method: 'POST', body: JSON.stringify(results) });
    })();
})();
