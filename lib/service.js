'use strict';

// "<command> install-service" / "<command> uninstall-service"
// Sets up (or removes) a systemd unit and, optionally, a udev rule for the pendant.
// All names and paths are derived from package.json and the running Node, so a package rename
// carries through and the unit never depends on PATH (nvm installs work).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

const NAME = pkg.name.replace(/^@[^/]+\//, '');
const COMMAND = typeof pkg.bin === 'string' ? NAME : Object.keys(pkg.bin)[0];
const BIN = path.resolve(__dirname, '..', typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0]);
const NODE = process.execPath;
const UNIT_PATH = '/etc/systemd/system/' + NAME + '.service';
const RULE_PATH = '/etc/udev/rules.d/99-' + NAME + '.rules';

/**
 * Prints an error message and exits with status 1.
 *
 * @param {string} msg - the message to print to stderr
 * @returns {never}
 */
const die = (msg) => { console.error(msg); process.exit(1); };
/**
 * Quotes a path for use in a systemd ExecStart line when it contains whitespace.
 *
 * @param {string} s - the path
 * @returns {string} the path, wrapped in double quotes if needed
 */
const quote = (s) => (/\s/.test(s) ? '"' + s + '"' : s);

/**
 * Prints the help text for the install-service / uninstall-service subcommands.
 *
 * @returns {void}
 */
function usage() {
    console.log([
        'Usage: sudo env "PATH=$PATH" ' + COMMAND + ' install-service [options]',
        '       sudo env "PATH=$PATH" ' + COMMAND + ' uninstall-service',
        '',
        '  --user USER       user the service runs as; must be the user that runs CNCjs, because the',
        '                    secret is read from that user\'s ~/.cncrc (default: $SUDO_USER)',
        '  --usb-port PORT   USB port the pendant is plugged into: the first KERNELS value of',
        '                    "udevadm info -a -n /dev/ttyUSBx", e.g. 1-2:1.0. Installs a udev rule that',
        '                    creates /dev/pendant and sets the port up so opening it does not reset the ESP32.',
        '  --start           start the service now (otherwise edit the config first)',
        '  --dry-run         print what would be written, change nothing (no root needed)'
    ].join('\n'));
}

/**
 * Parses the options that follow the subcommand. Exits with an error on an unknown option.
 *
 * @param {string[]} argv - arguments after the subcommand
 * @returns {{user: (string|undefined), usbPort: (string|undefined), start: (boolean|undefined),
 *   dryRun: (boolean|undefined), help: (boolean|undefined)}}
 */
function parseArgs(argv) {
    const o = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--user') o.user = argv[++i];
        else if (a === '--usb-port') o.usbPort = argv[++i];
        else if (a === '--start') o.start = true;
        else if (a === '--dry-run') o.dryRun = true;
        else if (a === '-h' || a === '--help') o.help = true;
        else die('Unknown option: ' + a);
    }
    return o;
}

/**
 * Finds the group that grants access to serial ports on this system ('dialout' on Debian and
 * Raspberry Pi OS, 'uucp' on Arch).
 *
 * @returns {?string} the group name, or null if neither exists
 */
function serialGroup() {
    try {
        const groups = fs.readFileSync('/etc/group', 'utf8');
        return ['dialout', 'uucp'].find((g) => new RegExp('^' + g + ':', 'm').test(groups)) || null;
    } catch (err) {
        return null;
    }
}

/**
 * Runs an external command with its output shown to the user.
 *
 * @param {string} cmd - the executable, e.g. 'systemctl'
 * @param {string[]} args - its arguments
 * @param {boolean} [tolerate=false] - when true a failure is ignored, otherwise the process exits
 * @returns {void}
 */
function run(cmd, args, tolerate) {
    try {
        execFileSync(cmd, args, { stdio: 'inherit' });
    } catch (err) {
        if (!tolerate) die(cmd + ' ' + args.join(' ') + ' failed');
    }
}

/**
 * Builds the text of the systemd unit. The unit runs the bridge with the absolute path of the Node
 * that executed this command, so it does not depend on PATH (nvm installs work). Config is found
 * the same way as when the bridge is started by hand, through the service user's home directory.
 *
 * @param {string} user - user the service runs as
 * @param {?string} group - supplementary group for serial port access, or null
 * @returns {string} the unit file content
 */
function unitText(user, group) {
    return [
        '[Unit]',
        'Description=' + (pkg.description || NAME),
        'After=network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        'User=' + user,
        group ? 'SupplementaryGroups=' + group : null,
        'ExecStart=' + quote(NODE) + ' ' + quote(BIN),
        'Restart=always',
        'RestartSec=3',
        'NoNewPrivileges=true',
        'ProtectSystem=full',
        'ProtectHome=read-only',
        'PrivateTmp=true',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        ''
    ].filter((l) => l !== null).join('\n');
}

/**
 * Builds the text of the udev rule for the pendant. The rule matches by USB port (so it never touches
 * the CNC controller's identical CH340), creates /dev/pendant, keeps ModemManager away, and sets the
 * port up without hangup-on-close so that opening it does not reset the ESP32.
 *
 * @param {string} usbPort - the KERNELS value of the pendant's USB port, e.g. '1-2:1.0'
 * @returns {string} the rule file content
 */
function ruleText(usbPort) {
    return [
        '# ' + NAME + ': stable /dev/pendant name, no ModemManager probing, and a port setup that does not',
        '# drop DTR/RTS (which would reset the ESP32 through its auto-reset circuit).',
        'SUBSYSTEM=="tty", ACTION=="add", KERNELS=="' + usbPort + '", SYMLINK+="pendant", ' +
            'ENV{ID_MM_DEVICE_IGNORE}="1", RUN+="/bin/stty -F /dev/%k 115200 raw -echo -crtscts -hupcl"',
        ''
    ].join('\n');
}

/**
 * Installs the systemd unit (and optionally the udev rule), reloads systemd and enables the service.
 * Needs root unless --dry-run is given, in which case the files are only printed.
 *
 * @param {object} o - parsed options from parseArgs()
 * @returns {void}
 */
function install(o) {
    const user = o.user || process.env.SUDO_USER;
    if (!user || user === 'root') die('Cannot tell which user should run the service. Use --user USER (the user running CNCjs).');
    if (o.usbPort && !/^[0-9]+-[0-9.]+:[0-9.]+$/.test(o.usbPort)) die('--usb-port should look like 1-2:1.0');
    if (!o.dryRun) {
        if (typeof process.getuid === 'function' && process.getuid() !== 0) {
            die('Needs root: sudo env "PATH=$PATH" ' + COMMAND + ' install-service ...');
        }
        try { execFileSync('id', ['-u', user], { stdio: 'ignore' }); } catch (err) { die('No such user: ' + user); }
    }
    const group = serialGroup();
    const unit = unitText(user, group);
    const rule = o.usbPort ? ruleText(o.usbPort) : null;

    if (o.dryRun) {
        console.log('# ' + UNIT_PATH + '\n' + unit);
        if (rule) console.log('# ' + RULE_PATH + '\n' + rule);
        return;
    }

    fs.writeFileSync(UNIT_PATH, unit);
    console.log('Wrote ' + UNIT_PATH);
    if (rule) {
        fs.writeFileSync(RULE_PATH, rule);
        run('udevadm', ['control', '--reload'], true);
        console.log('Wrote ' + RULE_PATH + ' (replug the pendant, then use /dev/pendant as the pendant port)');
    }
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['enable', NAME]);
    if (o.start) {
        run('systemctl', ['restart', NAME]);
        console.log('Started.');
    } else {
        console.log('Not started yet. Create the config (see the example in ' + path.resolve(__dirname, '..') +
            '), then: sudo systemctl start ' + NAME);
    }
    console.log('Logs:   journalctl -u ' + NAME + ' -f');
}

/**
 * Stops and disables the service and removes the unit and the udev rule. The config file is kept.
 * Needs root.
 *
 * @returns {void}
 */
function uninstall() {
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        die('Needs root: sudo env "PATH=$PATH" ' + COMMAND + ' uninstall-service');
    }
    run('systemctl', ['disable', '--now', NAME], true);
    [UNIT_PATH, RULE_PATH].forEach((f) => { try { fs.unlinkSync(f); console.log('Removed ' + f); } catch (err) { /* not there */ } });
    run('systemctl', ['daemon-reload'], true);
    run('udevadm', ['control', '--reload'], true);
    console.log('Done. The config file was left in place.');
}

/**
 * Entry point for the install-service / uninstall-service subcommands.
 *
 * @param {string} cmd - 'install-service' or 'uninstall-service'
 * @param {string[]} argv - the arguments after the subcommand
 * @returns {void}
 */
module.exports = function(cmd, argv) {
    const o = parseArgs(argv);
    if (o.help) return usage();
    if (cmd === 'uninstall-service') return uninstall();
    return install(o);
};
