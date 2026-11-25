/*
 * Injected into every page of the bundled configurator before any of its own code runs
 * (LocalContent.kt adds the <script> tag).
 *
 * 1. navigator.serial: Android's WebView has no Web Serial API. This implements the part
 *    of it the configurator uses on top of the native AM32Usb object (UsbSerialBridge.kt).
 * 2. Downloads: a WebView cannot save blob: URLs, so <a download> is routed to AM32Files.
 */
(function () {
    'use strict';

    var usb = window.AM32Usb;
    var files = window.AM32Files;

    if (window.__am32serial) {
        return;
    }

    // ---------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------

    function base64ToBytes (base64) {
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function bytesToBase64 (bytes) {
        var binary = '';
        var step = 0x8000; // String.fromCharCode.apply chokes on very long argument lists
        for (var i = 0; i < bytes.length; i += step) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
        }
        return btoa(binary);
    }

    // The configurator writes DataView chunks; Web Serial accepts any BufferSource.
    function toBytes (chunk) {
        if (chunk instanceof ArrayBuffer) {
            return new Uint8Array(chunk);
        }
        if (ArrayBuffer.isView(chunk)) {
            return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        }
        throw new TypeError('The chunk must be an ArrayBuffer or an ArrayBufferView.');
    }

    function domError (name, message) {
        return new DOMException(message, name);
    }

    // on<event> attribute the way browsers do it: one replaceable listener
    function defineHandler (target, type) {
        var current = null;
        Object.defineProperty(target, 'on' + type, {
            configurable: true,
            enumerable: true,
            get: function () { return current; },
            set: function (handler) {
                if (current) {
                    target.removeEventListener(type, current);
                }
                current = typeof handler === 'function' ? handler : null;
                if (current) {
                    target.addEventListener(type, current);
                }
            }
        });
    }

    // ---------------------------------------------------------------------------------
    // SerialPort
    // ---------------------------------------------------------------------------------

    var RX_BACKLOG_LIMIT = 256; // chunks kept while nobody holds the readable stream

    function AndroidSerialPort (info) {
        var port = Reflect.construct(EventTarget, [], AndroidSerialPort);
        port._key = info.key;
        port._info = { usbVendorId: info.vid, usbProductId: info.pid };
        port._name = info.name;
        port._open = false;
        port._readable = null;
        port._reader = null; // controller of _readable
        port._writable = null;
        port._backlog = [];
        defineHandler(port, 'connect');
        defineHandler(port, 'disconnect');
        return port;
    }
    AndroidSerialPort.prototype = Object.create(EventTarget.prototype, {
        constructor: { value: AndroidSerialPort, writable: true, configurable: true }
    });

    AndroidSerialPort.prototype.getInfo = function () {
        return { usbVendorId: this._info.usbVendorId, usbProductId: this._info.usbProductId };
    };

    Object.defineProperty(AndroidSerialPort.prototype, 'connected', {
        get: function () { return ports.get(this._key) === this; }
    });

    // As in the spec the streams are created lazily and replaced after they close or
    // error, so the page can always get a fresh one while the port is open.
    Object.defineProperty(AndroidSerialPort.prototype, 'readable', {
        get: function () {
            var port = this;
            if (!port._open) {
                return null;
            }
            if (!port._readable) {
                var stream = new ReadableStream({
                    start: function (controller) {
                        port._reader = controller;
                        var backlog = port._backlog;
                        port._backlog = [];
                        backlog.forEach(function (chunk) { controller.enqueue(chunk); });
                    },
                    cancel: function () {
                        if (port._readable === stream) {
                            port._readable = null;
                            port._reader = null;
                        }
                    }
                });
                port._readable = stream;
            }
            return port._readable;
        }
    });

    Object.defineProperty(AndroidSerialPort.prototype, 'writable', {
        get: function () {
            var port = this;
            if (!port._open) {
                return null;
            }
            if (!port._writable) {
                var stream = new WritableStream({
                    write: function (chunk) {
                        var error = usb.write(port._key, bytesToBase64(toBytes(chunk)));
                        if (error) {
                            if (port._writable === stream) {
                                port._writable = null;
                            }
                            throw domError('NetworkError', error);
                        }
                    },
                    close: function () {
                        if (port._writable === stream) {
                            port._writable = null;
                        }
                    },
                    abort: function () {
                        if (port._writable === stream) {
                            port._writable = null;
                        }
                    }
                });
                port._writable = stream;
            }
            return port._writable;
        }
    });

    AndroidSerialPort.prototype.open = function (options) {
        if (this._open) {
            return Promise.reject(domError('InvalidStateError', 'The port is already open.'));
        }
        var baudRate = options && Number(options.baudRate);
        if (!baudRate || baudRate <= 0) {
            return Promise.reject(new TypeError('A positive baudRate is required.'));
        }
        var error = usb.open(
            this._key,
            baudRate,
            Number(options.dataBits) || 8,
            Number(options.stopBits) || 1,
            options.parity || 'none'
        );
        if (error) {
            return Promise.reject(domError('NetworkError', 'Failed to open serial port: ' + error));
        }
        this._open = true;
        this._backlog = [];
        return Promise.resolve();
    };

    // error: the stream consumers get it as the reason; none means an orderly close
    AndroidSerialPort.prototype._teardown = function (error) {
        this._open = false;
        var controller = this._reader;
        this._readable = null;
        this._reader = null;
        this._writable = null;
        this._backlog = [];
        if (controller) {
            try {
                if (error) {
                    controller.error(error);
                } else {
                    controller.close();
                }
            } catch (e) { /* already closed or cancelled */ }
        }
    };

    AndroidSerialPort.prototype.close = function () {
        // More forgiving than the spec (which rejects while a stream is locked): the
        // configurator closes without waiting for its read loop to let go.
        if (this._open) {
            this._teardown(null);
            usb.close(this._key);
        }
        return Promise.resolve();
    };

    AndroidSerialPort.prototype.forget = function () {
        return this.close();
    };

    AndroidSerialPort.prototype.setSignals = function (signals) {
        if (!this._open) {
            return Promise.reject(domError('InvalidStateError', 'The port is closed.'));
        }
        var value = function (v) { return v === undefined ? -1 : (v ? 1 : 0); };
        signals = signals || {};
        var error = usb.setSignals(
            this._key,
            value(signals.dataTerminalReady),
            value(signals.requestToSend),
            value(signals.break)
        );
        return error ? Promise.reject(domError('NetworkError', error)) : Promise.resolve();
    };

    AndroidSerialPort.prototype.getSignals = function () {
        if (!this._open) {
            return Promise.reject(domError('InvalidStateError', 'The port is closed.'));
        }
        return Promise.resolve(JSON.parse(usb.getSignals(this._key)));
    };

    AndroidSerialPort.prototype._receive = function (bytes) {
        if (!this._open) {
            return;
        }
        if (this._reader) {
            try {
                this._reader.enqueue(bytes);
                return;
            } catch (e) { /* stream went away between the check and now: keep the data */ }
        }
        this._backlog.push(bytes);
        if (this._backlog.length > RX_BACKLOG_LIMIT) {
            this._backlog.shift();
        }
    };

    // ---------------------------------------------------------------------------------
    // navigator.serial
    // ---------------------------------------------------------------------------------

    var ports = new Map(); // key -> AndroidSerialPort, only ports the user granted
    var requests = new Map(); // request id -> { resolve, reject }
    var nextRequestId = 1;

    var serial = new EventTarget();
    defineHandler(serial, 'connect');
    defineHandler(serial, 'disconnect');

    function adopt (info) {
        var port = ports.get(info.key);
        if (!port) {
            port = AndroidSerialPort(info);
            ports.set(info.key, port);
            port.dispatchEvent(new Event('connect'));
            serial.dispatchEvent(new Event('connect'));
        }
        return port;
    }

    function drop (key, error) {
        var port = ports.get(key);
        if (!port) {
            return;
        }
        ports.delete(key);
        port._teardown(error || null);
        port.dispatchEvent(new Event('disconnect'));
        serial.dispatchEvent(new Event('disconnect'));
    }

    // The configurator polls getPorts() twice a second and compares ports by identity,
    // so the same device must keep returning the same object.
    serial.getPorts = function () {
        var list;
        try {
            list = JSON.parse(usb.listPorts());
        } catch (e) {
            return Promise.reject(domError('NetworkError', 'Cannot list USB devices.'));
        }
        var present = {};
        var result = list.map(function (info) {
            present[info.key] = true;
            return adopt(info);
        });
        Array.from(ports.keys()).forEach(function (key) {
            if (!present[key]) {
                drop(key, domError('NetworkError', 'The device has been lost.'));
            }
        });
        return Promise.resolve(result);
    };

    serial.requestPort = function (options) {
        var vendorIds = ((options && options.filters) || [])
            .map(function (filter) { return filter.usbVendorId; })
            .filter(function (id) { return typeof id === 'number'; });
        return new Promise(function (resolve, reject) {
            var id = nextRequestId++;
            requests.set(id, { resolve: resolve, reject: reject });
            usb.requestPort(id, JSON.stringify(vendorIds));
        });
    };

    // called by UsbSerialBridge.kt
    window.__am32serial = {
        onPortGranted: function (id, info) {
            var request = requests.get(id);
            requests.delete(id);
            var port = adopt(info);
            if (request) {
                request.resolve(port);
            }
        },
        onPortDenied: function (id) {
            var request = requests.get(id);
            requests.delete(id);
            if (request) {
                request.reject(domError('NotFoundError', 'No port selected by the user.'));
            }
        },
        onData: function (key, base64) {
            var port = ports.get(key);
            if (port) {
                port._receive(base64ToBytes(base64));
            }
        },
        onLost: function (key) {
            drop(key, domError('NetworkError', 'The device has been lost.'));
        }
    };

    if (usb) {
        Object.defineProperty(navigator, 'serial', {
            configurable: true,
            enumerable: true,
            value: serial
        });
        window.SerialPort = AndroidSerialPort;
    }

    // ---------------------------------------------------------------------------------
    // downloads
    // ---------------------------------------------------------------------------------

    if (files) {
        // The page revokes its object URL right after link.click(), long before the blob
        // could be fetched back, so remember the blob behind every URL it creates.
        var blobs = new Map();
        var createObjectURL = URL.createObjectURL;
        var revokeObjectURL = URL.revokeObjectURL;

        URL.createObjectURL = function (object) {
            var url = createObjectURL.call(URL, object);
            if (object instanceof Blob) {
                blobs.set(url, object);
            }
            return url;
        };
        URL.revokeObjectURL = function (url) {
            setTimeout(function () { blobs.delete(url); }, 30000);
            return revokeObjectURL.call(URL, url);
        };

        var fileName = function (anchor) {
            var name = anchor.getAttribute('download');
            if (name) {
                return name;
            }
            try {
                return decodeURIComponent(new URL(anchor.href).pathname.split('/').pop()) || 'download';
            } catch (e) {
                return 'download';
            }
        };

        // true when the download was taken over
        var saveAnchor = function (anchor) {
            if (!anchor || !anchor.hasAttribute('download') || !anchor.href) {
                return false;
            }
            var href = anchor.href;
            var name = fileName(anchor);
            if (href.indexOf('blob:') === 0) {
                var blob = blobs.get(href);
                if (!blob) {
                    return false;
                }
                blob.arrayBuffer().then(function (buffer) {
                    files.saveBase64(name, bytesToBase64(new Uint8Array(buffer)));
                });
                return true;
            }
            if (href.indexOf(location.origin + '/') === 0) {
                files.saveUrl(href, name);
                return true;
            }
            return false;
        };

        // links the user taps
        document.addEventListener('click', function (event) {
            var anchor = event.target && event.target.closest ? event.target.closest('a[download]') : null;
            if (anchor && saveAnchor(anchor)) {
                event.preventDefault();
            }
        }, true);

        // links the page clicks itself, usually without ever attaching them to the document
        var anchorClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
            if (!this.isConnected && saveAnchor(this)) {
                return;
            }
            return anchorClick.call(this);
        };
    }
})();
