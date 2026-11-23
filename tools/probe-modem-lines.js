#!/usr/bin/env node
'use strict';

// Prints the modem input lines (CTS, DSR, DCD) of a serial port twice a second and marks every change.
// Use it to check the wiring of the handwheel's power line before turning device.power on:
//   1. stop the bridge (it holds the port open; only one program can read it)
//   2. node tools/probe-modem-lines.js /dev/pendant
//   3. switch the handwheel off and on; the wired line must change and stay changed
//
// Reading: "1" means the line is asserted (the pin is LOW, the inputs are active low), "0" means clear (pin HIGH).
// A line that never changes is not wired or not a pin of your chip. Floating inputs flicker between 0 and 1.
// The port is opened without touching DTR/RTS (hupcl off), so the ESP32 is not reset by this script.
// Ctrl-C ends it. Options: --interval <ms> (default 500)

const { SerialPort } = require('serialport');

const args = process.argv.slice(2);
const iv = args.indexOf('--interval');
const interval = iv >= 0 ? Math.max(50, Number(args.splice(iv, 2)[1]) || 500) : 500;
const devicePath = args[0] || '/dev/pendant';
const LINES = ['cts', 'dsr', 'dcd'];

const port = new SerialPort({ path: devicePath, baudRate: 115200, autoOpen: false, hupcl: false });
port.on('error', (err) => console.error('serial error:', err.message));

let last = '';
const started = Date.now();

/**
 * Reads the modem lines once and prints them when they differ from the last reading.
 *
 * @returns {void}
 */
function sample() {
    port.get((err, s) => {
        if (err) {
            console.error('cannot read the modem lines:', err.message);
            console.error('(Bluetooth/rfcomm ports have none; a USB adapter whose driver lacks TIOCMGET does not either)');
            process.exit(1);
        }
        const text = LINES.map((n) => n.toUpperCase() + '=' + (s[n] ? 1 : 0)).join('  ');
        const t = ((Date.now() - started) / 1000).toFixed(1).padStart(7);
        if (text !== last) {
            console.log(t + ' s  ' + text + (last ? '   <- changed' : ''));
            last = text;
        }
    });
}

port.open((err) => {
    if (err) {
        console.error('cannot open ' + devicePath + ': ' + err.message);
        console.error('Is the bridge still running? Stop it first (sudo systemctl stop <service>).');
        process.exit(1);
    }
    console.log('Reading CTS / DSR / DCD of ' + devicePath + ' every ' + interval + ' ms. 1 = asserted (pin low), 0 = clear (pin high). Ctrl-C to quit.');
    sample();
    setInterval(sample, interval);
});

process.on('SIGINT', () => process.exit(0));
