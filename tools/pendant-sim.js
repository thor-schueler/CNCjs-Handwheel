#!/usr/bin/env node
'use strict';

// Command line emulator of the ESP32 handwheel, for testing the bridge without the hardware.
//
// It speaks the same protocol as the firmware: newline terminated text lines
//   to the bridge:   G21G91X+0.1F2000 (jog), $H, !, ~, ^X (0x18), ?, PING, 0x85 (jog cancel), "; log text"
//   from the bridge: <Idle|MPos:x,y,z|WPos:x,y,z|FS:feed,spindle>, PONG, ERR:...
//
// Connect it to the bridge through a pair of linked virtual serial ports, for example with socat:
//
//   socat -d -d pty,raw,echo=0,link=/tmp/pendant-sim pty,raw,echo=0,link=/tmp/pendant-bridge
//   node bin/cncjs-handwheel --pendant-port /tmp/pendant-bridge ...
//   node tools/pendant-sim.js --port /tmp/pendant-sim
//
// Interactive keys:
//   arrows left/right  X- / X+          up/down  Y+ / Y-        PgUp/PgDn or u/j  Z+ / Z-
//   1 2 3 4            step 1 / 0.1 / 0.01 / 0.001 mm
//   h                  home ($H)         space  feed hold (!)     r  cycle start (~)
//   X                  soft reset (^X)   ?      status request    p  PING
//   c                  jog cancel (0x85) l      log line ("; ...")
//   b                  burst: many jogs in the last direction, to reproduce a wheel being spun fast
//   q or Ctrl-C        quit
// Holding a jog key auto-repeats, which behaves like turning the wheel.
//
// Script mode (no keyboard needed, good for repeatable tests):
//   node tools/pendant-sim.js --port /tmp/pendant-sim --script "step:0.1, x+*200@100, wait:500, cancel"
//   tokens (separated by commas or spaces):
//     x+ x- y+ y- z+ z-   one jog with the current step      x+*200@100  200 jogs at 100 per second
//     step:0.1  feed:2000  home  hold  resume  reset  status  ping  cancel
//     log:text            send "; text"                      raw:LINE  send any line as it is
//     wait:500            wait 500 ms

const readline = require('readline');
const { SerialPort } = require('serialport');

const STEPS = { 1: '1', 2: '0.1', 3: '0.01', 4: '0.001' };

/**
 * Parses the command line.
 *
 * @param {string[]} argv - arguments after the script name
 * @returns {{port: ?string, baud: number, step: string, feed: number, script: ?string, burstCount: number,
 *   burstHz: number, help: boolean}}
 */
function parseArgs(argv) {
    const o = { port: null, baud: 115200, step: '0.1', feed: 2000, script: null, burstCount: 500, burstHz: 100, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--port' || a === '-p') o.port = argv[++i];
        else if (a === '--baud') o.baud = Number(argv[++i]);
        else if (a === '--step') o.step = String(argv[++i]);
        else if (a === '--feed') o.feed = Number(argv[++i]);
        else if (a === '--script') o.script = argv[++i];
        else if (a === '--burst-count') o.burstCount = Number(argv[++i]);
        else if (a === '--burst-hz') o.burstHz = Number(argv[++i]);
        else if (a === '-h' || a === '--help') o.help = true;
        else { console.error('Unknown option: ' + a); process.exit(1); }
    }
    return o;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help || !opts.port) {
    console.log('Usage: node tools/pendant-sim.js --port <serial port> [--baud 115200] [--step 0.1] [--feed 2000]\n' +
        '         [--burst-count 500] [--burst-hz 500] [--script "x+*200@100, wait:500"]');
    process.exit(opts.help ? 0 : 1);
}

const interactive = !opts.script && process.stdin.isTTY;
if (!opts.script && !interactive) {
    console.error('No terminal and no --script: nothing to do.');
    process.exit(1);
}

const sim = {
    step: opts.step,
    feed: opts.feed,
    last: { axis: 'X', dir: 1 },   // last jog direction, used by the burst
    tx: 0,                          // lines sent
    rx: 0,                          // lines received
    status: null,                   // last parsed status {state, mpos, wpos, feed, spindle}
    statusAt: 0,
    statusCount: 0,
    errors: 0,
    timers: new Set()
};

const port = new SerialPort({ path: opts.port, baudRate: opts.baud, autoOpen: false });
let rxBuf = '';

/**
 * Prints one line above the live status line (or just prints it when not on a terminal).
 *
 * @param {string} text
 * @returns {void}
 */
function log(text) {
    if (interactive) process.stdout.write('\r\x1b[K' + text + '\n');
    else console.log(text);
    render();
}

/**
 * Redraws the live status line (terminal only): state, machine and work position, step, counters.
 *
 * @returns {void}
 */
function render() {
    if (!interactive) return;
    const st = sim.status;
    const age = sim.statusAt ? Math.round((Date.now() - sim.statusAt)) : null;
    const fmt = (p) => (p ? ['x', 'y', 'z'].map((k) => k.toUpperCase() + ' ' + Number(p[k]).toFixed(3).padStart(9)).join('  ') : '(no position)');
    const line = (st ? st.state.padEnd(10) : 'no status'.padEnd(10)) + ' WPos ' + fmt(st && st.wpos) +
        ' | step ' + sim.step + ' F' + sim.feed + ' | tx ' + sim.tx + ' rx ' + sim.rx +
        (age === null ? '' : ' | status ' + age + ' ms ago');
    process.stdout.write('\r\x1b[K\x1b[7m' + line + '\x1b[0m');
}

/**
 * Sends one line to the bridge.
 *
 * @param {string} text - the line without terminator
 * @returns {void}
 */
function sendLine(text) {
    if (!port.isOpen) return;
    // single control bytes such as 0x85 (jog cancel) go out as that raw byte, not as UTF-8
    port.write(Buffer.from(text + '\n', /^[\x80-\xff]+$/.test(text) ? 'latin1' : 'utf8'));
    sim.tx++;
}

/**
 * Sends a jog line in the firmware's format, e.g. `G21G91X+0.1F2000`, and remembers the direction.
 *
 * @param {string} axis - X, Y or Z
 * @param {number} dir - 1 or -1
 * @returns {void}
 */
function jog(axis, dir) {
    sim.last = { axis, dir };
    sendLine('G21G91' + axis + (dir > 0 ? '+' : '-') + sim.step + 'F' + sim.feed);
}

/**
 * Sends `count` jogs in the last direction at `hz` jogs per second (0 = as fast as the loop runs),
 * like a wheel being spun hard.
 *
 * @param {number} count
 * @param {number} hz
 * @param {{axis: string, dir: number}} [where] - axis and direction (default: the last jog)
 * @returns {Promise<void>} resolves when all jogs have been sent
 */
function burst(count, hz, where) {
    const w = where || sim.last;
    return new Promise((resolve) => {
        let sent = 0;
        // up to 100 ticks per second; above 100 jogs per second a tick sends a small batch
        const interval = hz > 0 && hz <= 100 ? Math.round(1000 / hz) : 10;
        const per = hz > 100 ? Math.round(hz / 100) : hz > 0 ? 1 : 200;
        const tick = () => {
            for (let i = 0; i < per && sent < count; i++, sent++) jog(w.axis, w.dir);
            if (sent >= count) { sim.timers.delete(t); clearInterval(t); resolve(); }
        };
        const t = setInterval(tick, interval);
        sim.timers.add(t);
    });
}

/**
 * Parses a status line from the bridge and records it.
 *
 * @param {string} line - e.g. `<Idle|MPos:-10.000,0.000,0.000|WPos:-15.000,0.000,0.000|FS:0,0>`
 * @returns {boolean} true if it was a status line
 */
function parseStatus(line) {
    const m = /^<([^|>]+)((?:\|[^|>]*)*)>$/.exec(line);
    if (!m) return false;
    const st = { state: m[1], mpos: null, wpos: null, feed: null, spindle: null };
    m[2].split('|').filter(Boolean).forEach((f) => {
        const [k, v] = f.split(':');
        const n = (v || '').split(',').map(Number);
        if (k === 'MPos') st.mpos = { x: n[0], y: n[1], z: n[2] };
        else if (k === 'WPos') st.wpos = { x: n[0], y: n[1], z: n[2] };
        else if (k === 'FS') { st.feed = n[0]; st.spindle = n[1]; }
    });
    sim.status = st;
    sim.statusAt = Date.now();
    sim.statusCount++;
    return true;
}

/**
 * Handles bytes from the bridge: splits them into lines, tracks status lines, prints everything else.
 *
 * @param {Buffer} buf
 * @returns {void}
 */
function onData(buf) {
    rxBuf += buf.toString('utf8');
    let i;
    while ((i = rxBuf.search(/[\r\n]/)) >= 0) {
        const line = rxBuf.slice(0, i).trim();
        rxBuf = rxBuf.slice(i + 1);
        if (!line) continue;
        sim.rx++;
        if (parseStatus(line)) continue;
        if (line.startsWith('ERR')) sim.errors++;
        log('< ' + line);
    }
    if (rxBuf.length > 1024) rxBuf = '';
    render();
}

/**
 * Stops everything and exits.
 *
 * @param {number} [code=0]
 * @returns {void}
 */
function quit(code) {
    sim.timers.forEach((t) => clearInterval(t));
    if (interactive) {
        process.stdin.setRawMode(false);
        process.stdout.write('\r\x1b[K\n');
    }
    port.close(() => process.exit(code || 0));
    setTimeout(() => process.exit(code || 0), 500);
}

/**
 * Prints the final summary of a run (script mode).
 *
 * @returns {void}
 */
function summary() {
    const st = sim.status;
    console.log('SUMMARY tx=' + sim.tx + ' rx=' + sim.rx + ' statusLines=' + sim.statusCount + ' errors=' + sim.errors +
        (st ? ' state=' + st.state + ' wpos=' + (st.wpos ? [st.wpos.x, st.wpos.y, st.wpos.z].join(',') : 'none') : ' state=none'));
}

/**
 * Runs a script (see the header of this file) and then exits.
 *
 * @param {string} text - the script
 * @returns {Promise<void>}
 */
async function runScript(text) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const simple = { home: '$H', hold: '!', resume: '~', reset: '\x18', status: '?', ping: 'PING', cancel: '\x85' };
    for (const tok of text.split(/[,\s]+/).filter(Boolean)) {
        let m;
        if ((m = /^([xyz])([+-])(?:\*(\d+)(?:@(\d+))?)?$/i.exec(tok))) {
            const axis = m[1].toUpperCase(); const dir = m[2] === '+' ? 1 : -1;
            if (m[3]) await burst(Number(m[3]), Number(m[4] || 0), { axis, dir });
            else jog(axis, dir);
        } else if ((m = /^step:(.+)$/.exec(tok))) sim.step = m[1];
        else if ((m = /^feed:(\d+)$/.exec(tok))) sim.feed = Number(m[1]);
        else if ((m = /^wait:(\d+)$/.exec(tok))) await sleep(Number(m[1]));
        else if ((m = /^log:(.*)$/.exec(tok))) sendLine('; ' + m[1]);
        else if ((m = /^raw:(.*)$/.exec(tok))) sendLine(m[1]);
        else if (simple[tok]) sendLine(simple[tok]);
        else { console.error('Unknown script token: ' + tok); quit(1); return; }
    }
    await sleep(300); // let the last answers arrive
    summary();
    quit(0);
}

/**
 * Wires the keyboard to the simulator (interactive mode).
 *
 * @returns {void}
 */
function startKeyboard() {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (str, key) => {
        key = key || {};
        if ((key.ctrl && key.name === 'c') || str === 'q') return quit(0);
        if (key.name === 'left') jog('X', -1);
        else if (key.name === 'right') jog('X', 1);
        else if (key.name === 'up') jog('Y', 1);
        else if (key.name === 'down') jog('Y', -1);
        else if (key.name === 'pageup' || str === 'u') jog('Z', 1);
        else if (key.name === 'pagedown' || str === 'j') jog('Z', -1);
        else if (STEPS[str]) { sim.step = STEPS[str]; }
        else if (str === 'h') { sendLine('$H'); log('> $H'); }
        else if (str === ' ') { sendLine('!'); log('> ! (feed hold)'); }
        else if (str === 'r') { sendLine('~'); log('> ~ (cycle start)'); }
        else if (str === 'X') { sendLine('\x18'); log('> ^X (soft reset)'); }
        else if (str === '?') sendLine('?');
        else if (str === 'p') { sendLine('PING'); log('> PING'); }
        else if (str === 'c') { sendLine('\x85'); log('> 0x85 (jog cancel)'); }
        else if (str === 'l') { sendLine('; hello from the simulator'); log('> ; hello from the simulator'); }
        else if (str === 'b') {
            log('> burst: ' + opts.burstCount + ' x ' + sim.last.axis + (sim.last.dir > 0 ? '+' : '-') + sim.step + ' at ' + opts.burstHz + '/s');
            burst(opts.burstCount, opts.burstHz).then(() => log('> burst sent'));
        }
        render();
    });
    setInterval(render, 200).unref();
}

port.on('data', onData);
port.on('error', (err) => { console.error('Serial error: ' + err.message); });
port.on('close', () => { if (interactive) log('(port closed)'); });
port.open((err) => {
    if (err) { console.error('Cannot open ' + opts.port + ': ' + err.message); process.exit(1); }
    if (opts.script) runScript(opts.script);
    else { log('Pendant simulator on ' + opts.port + ' - arrows/PgUp/PgDn jog, 1-4 step, h home, b burst, c cancel, q quit'); startKeyboard(); }
});