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

const getUserHome = () => process.env[(process.platform === 'win32') ? 'USERPROFILE' : 'HOME'];

const generateAccessToken = (payload, secret, expiration) =>
    jwt.sign(payload, secret, { expiresIn: expiration });

// Returns the parsed ~/.cncrc, or {} if it cannot be read.
const readCncrc = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file || path.resolve(getUserHome(), '.cncrc'), 'utf8'));
    } catch (err) {
        return {};
    }
};

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

    const makeToken = () =>
        generateAccessToken({ id: '', name: 'cncjs-handwheel' }, options.secret, options.accessTokenLifetime);
    const address = 'ws://' + options.socketAddress + ':' + options.socketPort;

    const socket = io.connect(address, { query: 'token=' + makeToken() });
    let retryTimer = null;

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

module.exports.readCncrc = readCncrc;
