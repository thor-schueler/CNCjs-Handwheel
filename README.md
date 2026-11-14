# cncjs-handwheel

Bridge between CNCjs and a serial (USB or Bluetooth) ESP32 based handwheel (or any other handwheel that can communicate via USB or Bluetooth Serial). Runs on the same machine as CNCjs.

- pendant -> CNCjs: gcode lines, realtime commands, console log lines
- CNCjs -> pendant: status lines (state, MPos, WPos, feed/spindle), 10 per second
- health and pendant log as JSON on `http://127.0.0.1:8001` (for exposure in a CNCjs widget)

## Deploy

On the build machine: `npm pack` creates `cncjs-handwheel-<version>.tgz`.
On the CNCjs machine (Node 20+ required):

    tar xzf cncjs-handwheel-<version>.tgz
    cd package
    sudo bash deploy/install.sh --user <user running cncjs> --usb-port <KERNELS value>
    nano ~/.cncjs-handwheel.config
    sudo systemctl start cncjs-handwheel

`--usb-port` is optional. It is the USB port the pendant is plugged into, from
`udevadm info -a -n /dev/ttyUSBx | grep KERNELS` (first entry, e.g. `1-2:1.0`). It installs a udev rule that
gives the pendant a stable `/dev/pendant` and configures the port so that opening it does not reset the ESP32. It is important
to plug the handwheel into the same port every time for this to work. This is optional, but without this, the ESP32 may reboot
upon connecting. 

Update: install the new tarball the same way (config is kept). Remove: `sudo bash deploy/install.sh --uninstall`.

    journalctl -u cncjs-handwheel -f            # logs
    curl http://127.0.0.1:8001/status           # health
    curl "http://127.0.0.1:8001/log?since=0"    # pendant console log

Run by hand for debugging (`-v` = pendant events, `--trace` = all controller traffic):

    node bin/cncjs-handwheel --config ~/.cncjs-handwheel.config -v
    node bin/cncjs-handwheel --list             # serial ports

## Configuration

Precedence: defaults, `pendant` section of `~/.cncrc`, `~/.cncjs-handwheel.config` (or `--config`), command line.
See `cncjs-handwheel.config.example.json`.

| Key | Meaning |
|---|---|
| `cncjs.port` | CNC controller port as CNCjs knows it (not the pendant) |
| `cncjs.controllerType` | `Grbl` (Smoothie shares the state format) |
| `device.path` | pendant serial port, e.g. `/dev/pendant` |
| `device.baudRate`, `settleMs` | pendant baud rate; input ignored this long after opening |
| `device.hupcl`, `dtr`, `rts` | modem control line handling (see udev rule; defaults are fine) |
| `status.intervalMs` / `minGapMs` | status line at least every 100 ms / at most every 25 ms on change |
| `status.pollAfterCommand` | ask Grbl for a fresh report after each pendant command |
| `status.format` | `grbl` or `json` |
| `jog.translate` | rewrite `G21G91X10F500` style jogs to `$J=...` |
| `http` | health endpoint (`enabled`, `host`, `port`) |
| `log.max` | pendant log lines kept for the widget |

## Handwheel protocol

Newline-terminated text, printable ASCII (log lines may contain UTF-8).

Pendant -> bridge:

| Line | Effect |
|---|---|
| `G21G91X+10F2000` | jog (sent as `$J=...`); any other line not starting with ';' is sent as gcode |
| `!` / `~` / `^X` (0x18) | feed hold / cycle start / reset (each on its own line; reset limited to once per 2 s) |
| `?` or `STATUS?` | immediate status line |
| `PING` | reply `PONG` |
| `; text` | console log entry, shown in the widget, never sent to the controller |

Bridge -> pendant:

| Line | Meaning |
|---|---|
| `<Idle\|MPos:x,y,z\|WPos:x,y,z\|FS:feed,spindle>` | status; after every command and at least every 100 ms |
| `<Disconnected>` | bridge is up, CNCjs or the CNC port is not |
| `ERR:CNCJS_NOT_READY` | a command was dropped because the CNC port is not open |
| `PONG` | answer to `PING` |

If no line arrives for about 500 ms, treat the bridge as gone.
