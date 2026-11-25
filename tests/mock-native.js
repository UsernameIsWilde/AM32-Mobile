/*
 * Desktop stand-in for the two objects the Android app exposes to the page (AM32Usb from
 * UsbSerialBridge.kt, AM32Files from FileBridge.kt), used by tests/preview-server.mjs.
 *
 * The "USB device" is a minimal flight controller with four ESCs behind it: it answers the
 * MSP requests the configurator sends while connecting, then speaks the BLHeli 4-way
 * interface protocol the way a Betaflight passthrough does (identify, read, write), backed
 * by a small flash image per ESC. Enough to read, edit and save settings in the UI.
 */
(function () {
    'use strict';

    var KEY = '/dev/bus/usb/001/002';
    var DEVICE = { key: KEY, vid: 0x0483, pid: 0x5740, name: 'Mock FC (0483:5740)' };

    var bytesOf = function (base64) { return Uint8Array.from(atob(base64), function (c) { return c.charCodeAt(0); }); };
    var base64Of = function (bytes) { return btoa(String.fromCharCode.apply(null, bytes)); };

    var mock = window.mockNative = { granted: false, opened: [], closed: 0, requests: [], saved: [] };

    // payloads by MSP command number
    var PAYLOADS = {
        1: [0, 1, 46], // MSP_API_VERSION 1.46
        2: [0x42, 0x54, 0x46, 0x4C], // MSP_FC_VARIANT "BTFL"
        104: [0xE8, 0x03, 0xE8, 0x03, 0xE8, 0x03, 0xE8, 0x03], // MSP_MOTOR
        130: [4, 0xDC, 0x05, 168, 0, 0, 0, 0, 0], // MSP_BATTERY_STATE: 4S, 16.8 V
        131: [0x2E, 0x04, 0xD0, 0x07, 0xE8, 0x03, 4, 14, 0, 0], // MSP_MOTOR_CONFIG: 4 motors
        245: [4] // MSP_SET_PASSTHROUGH: four ESCs
    };

    // --- the ESCs -------------------------------------------------------------------------
    // STM32F051 (signature 0x1F06): settings at 0x7C00, the firmware name 32 bytes below.
    var EEPROM_ADDRESS = 0x7C00;
    var NAME_ADDRESS = EEPROM_ADDRESS - 32;
    var DEVINFO_MAGIC_ADDRESS = 0x23; // only v3 bootloaders answer this one
    // the default settings image for eeprom layout 4, as firmware 2.22
    var DEFAULTS = [
        0x01, 0x04, 0x01, 0x02, 0x16, 0xA0, 0x04, 0x00, 0x0A, 0x64, 0x00, 0x32, 0x02, 0x00, 0x35, 0x31,
        0x20, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x1A, 0x18, 0x64, 0x37, 0x0E, 0x00, 0x00, 0x05, 0x00,
        0x80, 0x80, 0x80, 0x32, 0x00, 0x32, 0x00, 0x00, 0x0F, 0x0A, 0x0A, 0x8D, 0x66, 0x06, 0x01, 0x00
    ];
    var escs = [0, 1, 2, 3].map(function (index) {
        var flash = new Uint8Array(0x10000).fill(0xFF);
        flash.set(DEFAULTS, EEPROM_ADDRESS);
        var name = 'AGFRC_V2_F051';
        for (var i = 0; i < 32; i++) {
            flash[NAME_ADDRESS + i] = i < name.length ? name.charCodeAt(i) : 0;
        }
        if (index === 2) {
            flash[EEPROM_ADDRESS + 27] = 12; // ESC 3 differs in one setting (motor poles)
        }
        return flash;
    });
    var target = 0;
    mock.escs = escs;
    mock.fourWay = [];

    function crc16Xmodem (bytes) {
        var crc = 0;
        for (var i = 0; i < bytes.length; i++) {
            crc ^= bytes[i] << 8;
            for (var bit = 0; bit < 8; bit++) {
                crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
            }
        }
        return crc;
    }

    // request:  0x2F cmd addrH addrL count params... crcH crcL
    // response: 0x2E cmd addrH addrL count params... ack crcH crcL   (count 0 means 256)
    function answerFourWay (request) {
        var command = request[1];
        var address = (request[2] << 8) | request[3];
        var count = request[4] === 0 ? 256 : request[4];
        var params = Array.prototype.slice.call(request, 5, 5 + count);
        var data = [0];
        var ack = 0x00;
        mock.fourWay.push(command);

        if (command === 0x37) { // DeviceInitFlash: signature, bootloader input pin (PB4), interface mode
            target = params[0] < escs.length ? params[0] : 0;
            data = [0x06, 0x1F, 0x14, 0x04];
        } else if (command === 0x3A) { // DeviceRead
            var length = params[0] === 0 ? 256 : params[0];
            if (address === DEVINFO_MAGIC_ADDRESS) {
                ack = 0x0F; // a pre-v3 bootloader refuses the magic read
            } else {
                data = Array.prototype.slice.call(escs[target], address, address + length);
            }
        } else if (command === 0x3B) { // DeviceWrite
            escs[target].set(params, address);
        }
        // everything else (alive, exit, reset, ...) is simply acknowledged

        var frame = [0x2E, command, address >> 8, address & 0xFF, data.length === 256 ? 0 : data.length].concat(data, [ack]);
        var crc = crc16Xmodem(frame);
        return Uint8Array.from(frame.concat([crc >> 8, crc & 0xFF]));
    }

    function crc8DvbS2 (bytes) {
        var crc = 0;
        for (var i = 0; i < bytes.length; i++) {
            crc ^= bytes[i];
            for (var bit = 0; bit < 8; bit++) {
                crc = (crc & 0x80) ? ((crc << 1) ^ 0xD5) & 0xFF : (crc << 1) & 0xFF;
            }
        }
        return crc;
    }

    // "$M<" (v1) and "$X<" (v2) requests -> the matching "$M>" / "$X>" reply
    function answer (request) {
        if (request[0] === 0x2F) {
            return answerFourWay(request);
        }
        if (request[0] !== 0x24 || request[2] !== 0x3C) {
            return null;
        }
        if (request[1] === 0x4D) {
            var command = request[4];
            var payload = PAYLOADS[command] || [];
            var body = [payload.length, command].concat(payload);
            var checksum = body.reduce(function (a, b) { return a ^ b; }, 0);
            mock.requests.push(command);
            return Uint8Array.from([0x24, 0x4D, 0x3E].concat(body, [checksum]));
        }
        if (request[1] === 0x58) {
            var command2 = request[4] | (request[5] << 8);
            var payload2 = PAYLOADS[command2] || [];
            var body2 = [0, command2 & 0xFF, command2 >> 8, payload2.length & 0xFF, payload2.length >> 8].concat(payload2);
            mock.requests.push(command2);
            return Uint8Array.from([0x24, 0x58, 0x3E].concat(body2, [crc8DvbS2(body2)]));
        }
        return null;
    }

    window.AM32Usb = {
        listPorts: function () { return JSON.stringify(mock.granted ? [DEVICE] : []); },
        requestPort: function (id) {
            setTimeout(function () {
                mock.granted = true;
                window.__am32serial.onPortGranted(id, DEVICE);
            }, 50);
        },
        open: function (key, baudRate, dataBits, stopBits, parity) {
            mock.opened.push([baudRate, dataBits, stopBits, parity]);
            return '';
        },
        write: function (key, base64) {
            var reply = answer(bytesOf(base64));
            if (reply) {
                setTimeout(function () { window.__am32serial.onData(key, base64Of(reply)); }, 10);
            }
            return '';
        },
        close: function () { mock.closed++; return ''; },
        setSignals: function () { return ''; },
        getSignals: function () { return '{}'; }
    };

    window.AM32Files = {
        saveBase64: function (name) { mock.saved.push(name); console.log('[mock] saved ' + name); },
        saveUrl: function (url, name) { mock.saved.push(name); console.log('[mock] saved ' + name + ' from ' + url); }
    };
})();
