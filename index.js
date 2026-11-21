'use strict';

// CNCjs client helper (adapted from cncjs-pendant-keyboard/index.js).
//
// Differences from the original:
//  - returns a connection object immediately and keeps the connection alive by itself:
//      * every (re)connect builds a brand new socket.io client with a fresh access token,
//        so no stale socket.io state or expired token can survive a CNCjs restart
//      * after each connect the CNC port is opened (or attached to) and the answer is
//        verified; no answer -> ask again -> still no answer -> rebuild the connection
//      * a periodic keepalive repeats the open request, which detects (and repairs) a server
//        that has forgotten this client
//      * a failed port open is retried every options.retryInterval, a port that is closed
//        behind our back is reopened (options.reopenOnClose)
//  - nothing is buffered while disconnected: emit() returns false instead of replaying stale
//    commands after the reconnect (socket.io would otherwise do exactly that)
//  - lifecycle events are always logged; controller traffic only with options.verbose
//  - callback(err) is called for open errors, callback(null, connection) on every successful
//    port open

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');
const jwt = require('jsonwebtoken');
const get = require('lodash.get');

/**
 * Returns the current user's home directory.
 *
 * @returns {string|undefined} $HOME (or %USERPROFILE% on Windows)
 */
const getUserHome = () => process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];

/**
 * Signs a CNCjs access token.
 *
 * @param {object} payload - token payload, e.g. { id: '', name: 'cncjs-handwheel' }
 * @param {string} secret - the CNCjs secret
 * @param {string|number} expiration - token lifetime understood by jsonwebtoken, e.g. '30d'
 * @returns {string} the signed JWT
 */
const generateAccessToken = (payload, secret, expiration) =>
    jwt.sign(payload, secret, { expiresIn: expiration });

/**
 * Reads and parses the CNCjs configuration file.
 *
 * @param {string} [file] - path of the file (default: ~/.cncrc)
 * @returns {object} the parsed config, or {} if the file is missing or invalid
 */
const readCncrc = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file || path.resolve(getUserHome(), '.cncrc'), 'utf8'));
    } catch (err) {
        return {};
    }
};

/**
 * Connects to the CNCjs server, opens (or attaches to) the CNC serial port and keeps both alive.
 *
 * The returned connection has the parts of the socket.io client API the bridge needs:
 * `on`, `once`, `off`, `emit`, `close` and the read-only properties `connected` and `portOpen`.
 * It stays valid across reconnects (the socket.io client underneath is replaced on every reconnect).
 * Events from the server are delivered to `on` listeners; `connect` and `disconnect` are emitted
 * on every (re)connect / loss of the connection.
 *
 * @param {object} options
 * @param {string} options.port - CNC controller port as known to CNCjs, e.g. /dev/ttyUSB0
 * @param {string} [options.secret] - CNCjs secret (default: $CNCJS_SECRET, then ~/.cncrc)
 * @param {number} [options.baudrate=115200] - CNC controller baud rate
 * @param {string} [options.socketAddress='localhost'] - CNCjs host
 * @param {number} [options.socketPort=8000] - CNCjs port
 * @param {string} [options.controllerType='Grbl'] - Grbl | Smoothie | TinyG
 * @param {string} [options.accessTokenLifetime='30d'] - lifetime of each generated token
 * @param {number} [options.retryInterval=5000] - ms before a failed or lost port open is retried, 0 = never
 * @param {number} [options.openTimeout=5000] - ms to wait for CNCjs to answer an open request
 * @param {number} [options.maxOpenTries=3] - unanswered open requests before the connection is rebuilt
 * @param {number} [options.keepaliveMs=30000] - interval of the keepalive open request, 0 = off
 * @param {boolean} [options.reopenOnClose=true] - reopen the port when it was closed (e.g. from the CNCjs UI)
 * @param {number} [options.reconnectMin=1000] - first delay (ms) before rebuilding a lost connection
 * @param {number} [options.reconnectMax=10000] - maximum delay (ms) between rebuilds
 * @param {boolean} [options.verbose=false] - log all serialport:read / serialport:write traffic
 * @param {function(Error|null, object=)} [callback] - called with (null, connection) on every
 *   answered open request and with (err) on every failed one
 * @returns {{connected: boolean, portOpen: boolean, on: function, once: function, off: function,
 *   emit: function(...*): boolean, close: function}} the connection
 */
module.exports = function(options, callback) {
    options = options || {};
    callback = callback || function() {};
    options.secret = get(options, 'secret', process.env['CNCJS_SECRET']);
    options.baudrate = get(options, 'baudrate', 115200);
    options.socketAddress = get(options, 'socketAddress', 'localhost');
    options.socketPort = get(options, 'socketPort', 8000);
    options.controllerType = get(options, 'controllerType', 'Grbl');
    options.accessTokenLifetime = get(options, 'accessTokenLifetime', '30d');
    options.retryInterval = get(options, 'retryInterval', 5000);
    options.openTimeout = get(options, 'openTimeout', 5000);
    options.maxOpenTries = get(options, 'maxOpenTries', 3);
    options.keepaliveMs = get(options, 'keepaliveMs', 30000);
    options.reopenOnClose = get(options, 'reopenOnClose', true);
    options.reconnectMin = get(options, 'reconnectMin', 1000);
    options.reconnectMax = get(options, 'reconnectMax', 10000);
    options.verbose = get(options, 'verbose', false);

    if (!options.secret) {
        options.secret = readCncrc().secret;
        if (!options.secret) {
            console.error('No CNCjs secret found. Use --secret, $CNCJS_SECRET or ~/.cncrc');
            process.exit(1);
        }
    }

    const address = 'ws://' + options.socketAddress + ':' + options.socketPort;
    const bus = new EventEmitter(); // where the listeners of the returned connection are attached

    let socket = null;       // the current socket.io client
    let generation = 0;      // bumped whenever the current socket is replaced; stale sockets are ignored
    let connected = false;   // the current socket is connected to CNCjs
    let portOpen = false;    // CNCjs has confirmed that the CNC port is open and we are attached to it
    let openTries = 0;       // unanswered open requests since the last answer
    let backoff = options.reconnectMin;
    let closed = false;
    let openTimer = null;
    let rebuildTimer = null;
    let keepaliveTimer = null;

    /**
     * Creates a fresh access token (a new one for every new socket).
     *
     * @returns {string} the signed JWT
     */
    const makeToken = () =>
        generateAccessToken({ id: '', name: 'cncjs-handwheel' }, options.secret, options.accessTokenLifetime);

    /**
     * Extracts a printable message from a socket.io error value.
     *
     * @param {*} err - Error, string or anything else
     * @returns {string}
     */
    const errText = (err) => (err && err.message ? err.message : String(err));

    /**
     * Records whether the CNC port is open and logs the transitions (not every confirmation).
     *
     * @param {boolean} value
     * @param {object} [data] - the serialport:open payload, for the log line
     * @returns {void}
     */
    function setPortOpen(value, data) {
        if (value === portOpen) return;
        portOpen = value;
        if (value) {
            data = data || {};
            console.log('Connected to port "' + (data.port || options.port) + '" (Baud rate: ' +
                (data.baudrate || options.baudrate) + ')');
        } else {
            console.log('CNC port "' + options.port + '" is not open');
        }
    }

    /**
     * Stops the open / keepalive timers (not the rebuild timer).
     *
     * @returns {void}
     */
    function stopOpenTimers() {
        clearTimeout(openTimer);
        clearInterval(keepaliveTimer);
        openTimer = null;
        keepaliveTimer = null;
    }

    /**
     * Marks the connection as lost and tells the listeners (once per connect).
     *
     * @param {string} reason - why, for the listeners and the log
     * @returns {void}
     */
    function markDisconnected(reason) {
        stopOpenTimers();
        const was = connected;
        connected = false;
        portOpen = false;
        if (was) {
            console.log('Disconnected from ' + address + ' (' + reason + ')');
            bus.emit('disconnect', reason);
        }
    }

    /**
     * Throws the current socket away. Everything it still emits is ignored afterwards.
     *
     * @returns {void}
     */
    function teardown() {
        generation++;
        const old = socket;
        socket = null;
        if (old) {
            try { old.close(); } catch (err) { /* already gone */ }
        }
    }

    /**
     * Schedules building a new socket (exponential backoff, at most one pending).
     *
     * @param {string} reason - why, for the log
     * @returns {void}
     */
    function scheduleRebuild(reason) {
        if (closed) return;
        markDisconnected(reason);
        teardown();
        if (rebuildTimer) return;
        const delay = backoff;
        backoff = Math.min(backoff * 2, options.reconnectMax);
        console.log('Reconnecting to ' + address + ' in ' + (delay / 1000) + ' s (' + reason + ')');
        rebuildTimer = setTimeout(() => { rebuildTimer = null; build(); }, delay);
    }

    /**
     * Asks CNCjs to open the CNC port, or to attach this client to it if it is already open
     * (for example opened by the CNCjs UI). CNCjs answers with serialport:open or serialport:error;
     * if it answers neither the request is repeated and finally the connection is rebuilt.
     *
     * @returns {void}
     */
    function requestOpen() {
        if (closed || !socket || !connected) return;
        clearTimeout(openTimer);
        openTries++;
        socket.emit('open', options.port, {
            baudrate: Number(options.baudrate),
            controllerType: options.controllerType
        });
        openTimer = setTimeout(onOpenTimeout, options.openTimeout);
    }

    /**
     * No answer to an open request within options.openTimeout: ask again, or rebuild the connection
     * after options.maxOpenTries unanswered requests.
     *
     * @returns {void}
     */
    function onOpenTimeout() {
        openTimer = null;
        if (closed || !connected) return;
        if (openTries >= options.maxOpenTries) {
            console.error('CNCjs did not answer ' + openTries + ' open requests for "' + options.port + '"');
            scheduleRebuild('no answer to open request');
            return;
        }
        console.warn('No answer from CNCjs to the open request for "' + options.port + '" (' + openTries + '/' +
            options.maxOpenTries + '), asking again');
        requestOpen();
    }

    /**
     * Retries the port open after options.retryInterval (used after an error or a close).
     *
     * @returns {void}
     */
    function retryOpenLater() {
        clearTimeout(openTimer);
        openTimer = null;
        if (options.retryInterval <= 0 || closed || !connected) return;
        openTimer = setTimeout(() => {
            openTimer = null;
            openTries = 0;
            requestOpen();
        }, options.retryInterval);
    }

    /**
     * Builds a new socket.io client and wires it up. The previous socket (if any) is discarded.
     *
     * @returns {void}
     */
    function build() {
        if (closed) return;
        clearTimeout(rebuildTimer);
        rebuildTimer = null;
        markDisconnected('rebuilding the connection');
        teardown();

        const gen = ++generation;
        const s = io.connect(address, {
            query: 'token=' + makeToken(),
            forceNew: true,       // own manager: nothing is shared with the previous client
            reconnection: false,  // reconnecting is done here, with a new client and a new token
            timeout: 10000
        });
        socket = s;
        const current = () => gen === generation && !closed;

        // Deliver every event from the server to the listeners of the returned connection.
        // (Copy the arguments first: socket.io appends its ack callback to packet.data.)
        const onevent = s.onevent;
        s.onevent = function(packet) {
            const args = (packet && packet.data ? packet.data : []).slice();
            onevent.apply(this, arguments);
            if (!current() || !args.length) return;
            if (args[0] === 'error' && bus.listenerCount('error') === 0) return;
            bus.emit.apply(bus, args);
        };

        s.on('connect', () => {
            if (!current()) return;
            connected = true;
            openTries = 0;
            console.log('Connected to ' + address);
            bus.emit('connect');
            requestOpen(); // attaches to the port if the CNCjs UI already opened it
        });

        s.on('disconnect', (reason) => {
            if (!current()) return;
            scheduleRebuild(reason || 'disconnected');
        });

        const failed = (what) => (err) => {
            if (!current()) return;
            console.error('CNCjs connection ' + what + ': ' + errText(err));
            if (!connected) scheduleRebuild(what);
        };
        s.on('connect_error', failed('error'));
        s.on('connect_timeout', failed('timeout'));
        s.on('error', failed('error'));

        s.on('serialport:open', (data) => {
            if (!current()) return;
            clearTimeout(openTimer);
            openTimer = null;
            openTries = 0;
            backoff = options.reconnectMin;
            setPortOpen(true, data);
            if (!keepaliveTimer && options.keepaliveMs > 0) {
                keepaliveTimer = setInterval(() => {
                    if (connected && portOpen && !openTimer) {
                        openTries = 0;
                        requestOpen();
                    }
                }, options.keepaliveMs);
            }
            callback(null, connection);
        });

        s.on('serialport:error', (data) => {
            if (!current()) return;
            data = data || {};
            setPortOpen(false);
            callback(new Error('Error opening serial port "' + (data.port || options.port) + '"'));
            retryOpenLater();
        });

        s.on('serialport:close', () => {
            if (!current()) return;
            setPortOpen(false);
            if (options.reopenOnClose) retryOpenLater();
        });

    }

    const connection = {
        /** @returns {boolean} true while connected to CNCjs */
        get connected() { return connected; },
        /** @returns {boolean} true while CNCjs confirms that the CNC port is open and attached */
        get portOpen() { return portOpen; },
        on(...args) { bus.on(...args); return connection; },
        once(...args) { bus.once(...args); return connection; },
        off(...args) { bus.removeListener(...args); return connection; },
        removeListener(...args) { bus.removeListener(...args); return connection; },
        /**
         * Sends an event to CNCjs. Nothing is queued: while the connection is down the event is
         * dropped and false is returned, so a stale command can never be replayed after a reconnect.
         *
         * @param {...*} args - event name and arguments, as for socket.io
         * @returns {boolean} true if the event was handed to the socket
         */
        emit(...args) {
            if (!socket || !connected) return false;
            socket.emit(...args);
            return true;
        },
        /**
         * Closes the connection for good and stops all timers.
         *
         * @returns {void}
         */
        close() {
            closed = true;
            clearTimeout(rebuildTimer);
            markDisconnected('closed');
            teardown();
        }
    };

    if (options.verbose) {
        bus.on('serialport:read', (data) => console.log('<', String(data || '').trim()));
        bus.on('serialport:write', (data) => console.log('>', String(data || '').trim()));
    }

    build();
    return connection;
};

/** Exposed so callers can read other sections (e.g. `pendant`) of ~/.cncrc. */
module.exports.readCncrc = readCncrc;