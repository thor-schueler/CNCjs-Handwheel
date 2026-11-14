# cncjs-handwheel

Bridge between CNCjs and a serial (USB or Bluetooth) ESP32 handwheel pendant. It runs on the same machine as CNCjs.

- pendant -> CNCjs: gcode lines, realtime commands, console log lines
- CNCjs -> pendant: status lines (state, MPos, WPos, feed/spindle), about 10 per second
- health and the pendant log as JSON on `http://127.0.0.1:8001` (for a CNCjs widget)

Requires Node 20 or newer and a CNCjs that uses socket.io 2.x (current CNCjs releases do).

## Install

    npm install -g cncjs-handwheel

Create the config (see below), then run it by hand to try it:

    cncjs-handwheel --config ~/.cncjs-handwheel.config -v

`-v` logs pendant events and the commands sent to CNCjs, `--trace` also logs all controller traffic,
`--list` lists the serial ports.

### Run as a service (systemd)

    sudo env "PATH=$PATH" cncjs-handwheel install-service --user <user running CNCjs> --usb-port 1-2:1.0
    sudo systemctl start cncjs-handwheel

- `--user` must be the user that runs CNCjs: the bridge reads the CNCjs secret from that user's `~/.cncrc`.
- `--usb-port` is optional. It is the USB port the pendant is plugged into, the first `KERNELS` value of
  `udevadm info -a -n /dev/ttyUSBx`. It installs a udev rule that creates `/dev/pendant` and sets up the port so
  that opening it does not reset the ESP32 through its auto-reset circuit. Replug the pendant afterwards.
- `sudo env "PATH=$PATH"` keeps an nvm-installed Node visible to root; with a system Node plain `sudo` works.
- The unit stores the absolute path of the Node that ran the command. After a Node upgrade run `install-service` again.
- `--dry-run` prints the unit and rule without changing anything.

Update: `npm install -g cncjs-handwheel@latest && sudo systemctl restart cncjs-handwheel`.
Remove: `sudo env "PATH=$PATH" cncjs-handwheel uninstall-service` (the config file stays).

    journalctl -u cncjs-handwheel -f            # logs
    curl http://127.0.0.1:8001/status           # health
    curl "http://127.0.0.1:8001/log?since=0"    # pendant console log

## Configuration

Precedence, lowest to highest: defaults, the `pendant` section of `~/.cncrc`, `~/.cncjs-handwheel.config`
(or the file given with `--config`), command line options. CNCjs rewrites `.cncrc` itself, so a separate file is safer.
Start from `cncjs-pendant.config.example.json`.

| Key | Meaning |
|---|---|
| `cncjs.port` | CNC controller port as CNCjs knows it (not the pendant) |
| `cncjs.controllerType` | `Grbl` (Smoothie shares the state format) |
| `device.path` | pendant serial port, e.g. `/dev/pendant` |
| `device.baudRate`, `device.settleMs` | pendant baud rate; pendant input is ignored this long after opening |
| `device.hupcl`, `dtr`, `rts` | modem control line handling (the defaults are fine with the udev rule) |
| `status.intervalMs`, `status.minGapMs` | status line at least every 100 ms, and at most every 25 ms when values change |
| `status.pollAfterCommand` | ask Grbl for a fresh report after each pendant command |
| `status.format` | `grbl` or `json` |
| `jog.translate` | rewrite jogs like `G21G91X10F500` to `$J=...` so they do not leave Grbl in relative mode |
| `http` | health endpoint (`enabled`, `host`, `port`) |
| `log.max` | pendant log lines kept for the widget |

## Pendant protocol

Newline-terminated text. Everything except log lines must be printable ASCII.

Pendant to bridge:

| Line | Effect |
|---|---|
| `G21G91X+10F2000` | jog (sent as `$J=...`); any other line is sent to the controller as gcode |
| `!` / `~` / `^X` (0x18) | feed hold / cycle start / reset, each as a line of its own (reset at most once per 2 s) |
| `?` or `STATUS?` | immediate status line |
| `PING` | answered with `PONG` |
| `; text` | console log entry for the widget; never sent to the controller |

Bridge to pendant:

| Line | Meaning |
|---|---|
| `<Idle\|MPos:x,y,z\|WPos:x,y,z\|FS:feed,spindle>` | status, after every command and at least every 100 ms |
| `<Disconnected>` | the bridge is up, but CNCjs or the CNC port is not |
| `ERR:CNCJS_NOT_READY` | a command was dropped because the CNC port is not open |
| `PONG` | answer to `PING` |

The status right after a command shows where the machine was at that moment; Grbl's `ok` only means the move was
queued. A fresh report follows within a few tens of milliseconds, and the 100 ms stream tracks the move.
If no line arrives for about 500 ms, treat the bridge as gone.

## Troubleshooting

- **ESP32 reboots or enters download mode when the port is opened.** Linux raises DTR and RTS on the first open, and
  the auto-reset circuit turns that into a reset. Use the udev rule from `--usb-port`. A capacitor of about 1 uF from
  EN to GND on the board removes the problem at its source.
- **Nothing from the pendant.** Run with `-v`. Lines rejected as non-text are reported as `dropped non-text line`
  and counted in `/status` (`pendant.garbageLines`); wrong baud rate and a rebooting ESP32 look like that.
- **`$$` and `$I` output at start.** Normal: CNCjs queries the controller when a client opens the CNC port.
- **No WPos.** Grbl reports the work offset only every 10-30 status reports; the first WPos can take a few seconds.
