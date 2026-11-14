'use strict';

// CNCjs client helper (adapted from cncjs-pendant-keyboard/index.js).
//
// Differences from the original:
//  - returns the socket immediately and keeps the connection alive:
//    re-opens the CNC port after (re)connects and retries if the open fails
//  - generates a fresh access token on every reconnect attempt, so a
//    long-running daemon never ends up with an expired token
//  - no implicit global `socket`; uses 'disconnect' (socket.io has no 'close')
//  - controller read/write logging only when options.verbose is set
//  - callback(err) is called for open errors, callback(null, socket) on every
//    successful port open

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
 * Reconnects automatically (with a fresh access token) and retries failed port opens.
 *
 * @param {object} options
 * @param {string} options.port - CNC controller port as known to CNCjs, e.g. /dev/ttyUSB0
 * @param {string} [options.secret] - CNCjs secret (default: $CNCJS_SECRET, then ~/.cncrc)
 * @param {number} [options.baudrate=115200] - CNC controller baud rate
 * @param {string} [options.socketAddress='localhost'] - CNCjs host
 * @param {number} [options.socketPort=8000] - CNCjs port
 * @param {string} [options.controllerType='Grbl'] - Grbl | Smoothie | TinyG
 * @param {string} [options.accessTokenLifetime='30d'] - lifetime of each generated token
 * @param {number} [options.retryInterval=5000] - ms between port open retries, 0 = never retry
 * @param {boolean} [options.verbose=false] - log all serialport:read / serialport:write traffic
 * @param {function(Error|null, object=)} [callback] - called with (null, socket) on every successful
 *   port open and with (err) on every failed one
 * @returns {object} the socket.io client socket (stays valid across reconnects)
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
    options.retryInterval = get(options, 'retryInterval', 5000); // ms, 0 = never retry
    options.verbose = get(options, 'verbose', false);

    if (!options.secret) {
        options.secret = readCncrc().secret;
        if (!options.secret) {
            console.error('No CNCjs secret found. Use --secret, $CNCJS_SECRET or ~/.cncrc');
            process.exit(1);
        }
    }

    /**
     * Creates a fresh access token for the connection (called on connect and on every reconnect attempt).
     *
     * @returns {string} the signed JWT
     */
    const makeToken = () =>
        generateAccessToken({ id: '', name: 'cncjs-handwheel' }, options.secret, options.accessTokenLifetime);
    const address = 'ws://' + options.socketAddress + ':' + options.socketPort;

    const socket = io.connect(address, { query: 'token=' + makeToken() });
    let retryTimer = null;

    /**
     * Asks CNCjs to open the CNC port. If the port is already open (e.g. by the CNCjs UI) this
     * attaches the pendant connection to it.
     *
     * @returns {void}
     */
    const openPort = () => {
        socket.emit('open', options.port, {
            baudrate: Number(options.baudrate),
            controllerType: options.controllerType
        });
    };

    // socket.io-client v2 reuses the original query on reconnect; refresh it.
    socket.on('reconnect_attempt', () => {
        socket.io.opts.query = 'token=' + makeToken();
    });

    socket.on('connect', () => {
        console.log('Connected to ' + address);
        openPort(); // attaches to the port if the CNCjs UI already opened it
    });

    socket.on('error', (err) => {
        console.error('Connection error:', err && err.message ? err.message : err);
    });

    socket.on('disconnect', () => {
        console.log('Disconnected from ' + address);
    });

    socket.on('serialport:open', (data) => {
        data = data || {};
        clearTimeout(retryTimer);
        console.log('Connected to port "' + data.port + '" (Baud rate: ' + data.baudrate + ')');
        callback(null, socket);
    });

    socket.on('serialport:error', (data) => {
        data = data || {};
        callback(new Error('Error opening serial port "' + data.port + '"'));
        if (options.retryInterval > 0) {
            clearTimeout(retryTimer);
            retryTimer = setTimeout(() => {
                if (socket.connected) {
                    openPort();
                }
            }, options.retryInterval);
        }
    });

    if (options.verbose) {
        socket.on('serialport:read', (data) => console.log('<', (data || '').trim()));
        socket.on('serialport:write', (data) => console.log('>', (data || '').trim()));
    }

    return socket;
};

/** Exposed so callers can read other sections (e.g. `pendant`) of ~/.cncrc. */
module.exports.readCncrc = readCncrc;
