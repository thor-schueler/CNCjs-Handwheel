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
- `--bt-mac` and `--bt-channel` are for a Bluetooth pendant instead of a USB one (use one or the other, not both).
  They install a second service that binds the pendant to `/dev/rfcomm0` at boot. See
  [Bluetooth pendant](#bluetooth-pendant-raspberry-pi), which also covers a kernel problem on the Raspberry Pi 4.
- `sudo env "PATH=$PATH"` keeps an nvm-installed Node visible to root; with a system Node plain `sudo` works.
- The unit stores the absolute path of the Node that ran the command. After a Node upgrade run `install-service` again.
- `--dry-run` prints the unit and rule without changing anything.

Update: `npm install -g cncjs-handwheel@latest && sudo systemctl restart cncjs-handwheel`.
Remove: `sudo env "PATH=$PATH" cncjs-handwheel uninstall-service` (the config file stays).

    journalctl -u cncjs-handwheel -f            # logs
    curl http://127.0.0.1:8001/status           # health
    curl "http://127.0.0.1:8001/log?since=0"    # pendant console log

## Bluetooth pendant (Raspberry Pi)

The pendant can connect over Bluetooth instead of USB. The firmware must offer **Bluetooth Classic serial (SPP)**,
for example the Arduino `BluetoothSerial` library. A BLE-only device does not work with this method.

> **Raspberry Pi 4 kernel warning.** With the Pi 4's **onboard** Bluetooth, **kernel 6.18 cannot pair or connect to the
> handwheel** (tested with `6.18.60+rpt-rpi-v8`): `btmon` shows `Status: Page Timeout (0x04)` for the connection
> attempt, `bluetoothctl pair` fails with `ConnectionAttemptFailed`, and `rfcomm connect` fails with `Host is down`.
> **Kernel 6.12 is required for that particular configuration** (Pi 4, onboard Bluetooth); on 6.12 the same handwheel
> connects normally. A **USB Bluetooth adapter also works on 6.18**. The cause is the kernel, not the handwheel. `install-service --bt-mac` prints a warning when it sees a 6.18 Raspberry Pi kernel.

### Setup

1. **Check the kernel.** `uname -r` should show a `6.12.x` kernel if you use the onboard Bluetooth. If apt has installed
   6.18, install a 6.12 kernel image and reboot (see the Raspberry Pi kernel documentation), then check `uname -r` again.
   To stop apt from upgrading it again, hold the kernel packages (check the names with `dpkg -l | grep linux-image`):

       sudo apt-mark hold linux-image-rpi-v8 linux-headers-rpi-v8

   A held kernel receives no updates, so remove the hold (`apt-mark unhold`) and retest when a newer kernel is
   out. With a USB adapter on 6.18 you can skip this; disable the onboard controller so there is only one,
   by adding `dtoverlay=disable-bt` to `/boot/firmware/config.txt` and rebooting.

2. **Pair the pendant** once, with the pendant switched on and close to the Pi. Stop scanning before you pair; pairing while
   a scan is running makes connection attempts fail:

       bluetoothctl
         agent on
         default-agent
         scan on                         # wait for: [NEW] Device AA:BB:CC:DD:EE:FF <pendant name>
         scan off
         pair AA:BB:CC:DD:EE:FF          # if asked for a PIN, enter it in this window (often 1234 or 0000)
         trust AA:BB:CC:DD:EE:FF
         quit

   `Connected: no` after pairing is normal; the connection is made when the bridge opens the port.

3. **Install the bindings and the service** (needs `bluez`, which provides `rfcomm`):

       sudo env "PATH=$PATH" cncjs-handwheel install-service --user <user running CNCjs> --bt-mac AA:BB:CC:DD:EE:FF

   Use `--bt-channel N` if the serial profile is not on RFCOMM channel 1 (the default and what the ESP32 uses).
   `--dry-run` shows what would be written. This creates `cncjs-handwheel-rfcomm.service`, which runs
   `rfcomm bind 0 <mac> <channel>` at boot, and makes the bridge service start after it.

4. **Point the bridge at the port.** In the config set `device.path` to `/dev/rfcomm0`, then
   `sudo systemctl start cncjs-handwheel`.

### Notes

- **One connection at a time.** The pendant accepts a single Bluetooth client. While the bridge is running it connects
  whenever the pendant is on and in range, so other programs (for example Candle on a PC) cannot use it. Stop the
  service first: `sudo systemctl stop cncjs-handwheel`.
- **Binding is not connecting.** The binding exists whether or not the pendant is on. The connection is made when the
  bridge opens `/dev/rfcomm0` and it retries every few seconds, so the pendant can be switched on later.
- **No reset problem.** The USB auto-reset issue (see Troubleshooting) does not exist over Bluetooth; the udev rule
  and `--usb-port` are not needed.
- **Removing:** `uninstall-service` stops both services and releases `/dev/rfcomm0`.

### Troubleshooting Bluetooth

- `Page Timeout` / `Host is down` / `ConnectionAttemptFailed`: first check `uname -r` (see the warning above). If the
  kernel is fine, check that no other device is connected to the pendant, move it closer, and look at `sudo btmon` while
  you retry.
- `rfcomm -a` lists the bindings, `bluetoothctl info AA:BB:CC:DD:EE:FF` shows the pairing state, and
  `journalctl -u cncjs-handwheel-rfcomm -u cncjs-handwheel -f` shows what the services are doing.
- No `/dev/rfcomm0`: `systemctl status cncjs-handwheel-rfcomm` (is `bluetooth.service` running? is `rfcomm` installed?).

## Configuration

Precedence, lowest to highest: defaults, the `pendant` section of `~/.cncrc`, `~/.cncjs-handwheel.config`
(or the file given with `--config`), command line options. CNCjs rewrites `.cncrc` itself, so a separate file is safer.
Start from `cncjs-handwheel.config.example.json`.

| Key | Meaning |
|---|---|
| `cncjs.port` | CNC controller port as CNCjs knows it (not the pendant) |
| `cncjs.controllerType` | `Grbl` (Smoothie shares the state format) |
| `cncjs.retryInterval` | ms before a failed or lost port open is retried (default 5000, 0 = never) |
| `cncjs.openTimeout`, `cncjs.maxOpenTries` | ms to wait for CNCjs to answer an open request (5000) and how many unanswered requests are tolerated before the connection to CNCjs is rebuilt (3) |
| `cncjs.keepaliveMs` | the open request is repeated this often (30000, 0 = off) to verify that CNCjs still has the bridge attached; no answer rebuilds the connection |
| `cncjs.reopenOnClose` | reopen the CNC port when it is closed behind the bridge's back, e.g. from the CNCjs UI (default `true`). Set `false` if you want the UI's Close to release the machine |
| `device.path` | pendant serial port: `/dev/pendant` (USB, with the udev rule) or `/dev/rfcomm0` (Bluetooth) |
| `device.baudRate`, `device.settleMs` | pendant baud rate; pendant input is ignored this long after opening |
| `device.send` | `false` (or `--no-pendant-send`): never write anything to the pendant, no status, `PONG` or `ERR`. Pendant to CNCjs keeps working. Useful when the firmware does not read from the serial port yet, or to rule the status stream out when debugging |
| `device.hupcl`, `dtr`, `rts` | modem control line handling (the defaults are fine with the udev rule) |
| `device.power` | `{line, poweredWhen, pollMs, debounceMs}`: detect that the handwheel is switched off while the USB cable is still plugged in, see "Detecting a switched-off handwheel". Off unless `line` is set |
| `status.intervalMs`, `status.minGapMs` | status line at least every 400 ms (the heartbeat), and never more often than every 350 ms (about 3 per second); a burst of commands or position changes costs one line per gap, always carrying the latest values. Explicit `?` / `STATUS?` requests are answered at once |
| `status.pollAfterCommand` | ask Grbl for a fresh report after pendant commands (at most one per `status.minGapMs`) |
| `status.format` | `grbl` or `json` |
| `jog.translate` | rewrite jogs like `G21G91X10F500` to `$J=...` so they do not leave Grbl in relative mode (default `true`; `false` or `--no-jog-translate` sends the pendant's lines as plain gcode, for comparing behavior) |
| `jog.maxInFlight` | jog governor (default `4`, `0` = off): at most this many gcode lines are handed to CNCjs without an `ok`/`error` reply from Grbl. While the limit is reached, further jogs on the same axis and feed are merged into one longer jog (`Y-0.1` three times becomes `Y-0.3`), opposite jogs cancel out, and the result is sent as soon as a reply frees a slot. The position stays exact; nothing is queued without limit. A different axis or feed replaces the held jog, and a feed hold or reset discards it. This protects Grbl's small serial buffer, which loses characters when a fast wheel outruns it |
| `jog.cancelSettleMs` | wait between emptying the CNCjs feeder queue and sending the Grbl jog cancel (default 40 ms, see "Jog cancel") |
| `jog.stallMs` | if the controller acknowledges nothing for this long (default 2000), the unanswered lines are assumed lost: the bridge prints a warning, counts a stall and starts counting afresh |
| `jog.echo` | tag jog lines with `{echo: false}` as context (default `false`; other gcode is not tagged). CNCjs passes it on in its `serialport:write` event, so a console widget can hide the `feeder> $J=...` echo. Stock CNCjs ignores it (see "Quieting the CNCjs console") |
| `http` | health endpoint (`enabled`, `host`, `port`) |
| `log.max` | pendant log lines kept for the widget |

## Detecting a switched-off handwheel

A USB serial chip such as the CH340 is powered by the cable, so when the handwheel's own power switch only cuts the
ESP32 (and display) the port stays open and the bridge cannot tell that nobody is listening. The way around is one
wire: the firmware drives a spare GPIO high once it is running, and that GPIO is connected to a **modem input of the
USB chip** (CTS#, DSR# or DCD#, whichever pin your chip has). The bridge reads that input; when the ESP32 has no power
the pin is not driven and a pull-down resistor holds it low.

Those inputs are active low, so a pin driven HIGH reads as *clear* and a pin pulled LOW reads as *set*. With the
wiring above the default `poweredWhen: "clear"` is right. Config:

```json
"device": { "power": { "line": "cts" } }
```

| Key | Meaning |
|---|---|
| `line` | `cts`, `dsr` or `dcd`: the input that is wired to the handwheel (`null` = off, the default) |
| `poweredWhen` | `clear` (default: pin high = switched on) or `set` (pin low = switched on, if you wired it the other way round) |
| `pollMs`, `debounceMs` | read the line every 250 ms; a change must last 1000 ms to count (opening the port can reset the ESP32 and make the pin dip) |

While the handwheel is off the bridge reports `pendant.powered: false` in `/status` (`null` = unknown, or not
configured), ignores whatever the adapter's RX line picks up, writes nothing to it, drops the stored battery state and
discards a jog that was being held back. The widget shows **Handwheel switched off** (grey) and `Off` in the glyph row.
After switch-on the bridge ignores the ESP32's boot output for `device.settleMs`, as it does after opening the port.

**Check the wiring first.** Stop the bridge (it holds the port) and run `node tools/probe-modem-lines.js /dev/pendant`
from the repository. It prints CTS, DSR and DCD twice a second and marks changes; switch the handwheel off and on and
the wired line must change and stay changed (`1` = pin low, `0` = pin high). A line that never moves is not wired or is
not a pin of your chip; one that flickers is floating. USB only: a Bluetooth link has no modem lines, and the bridge
turns the feature off with a message if the port cannot report them. GPIO2 is a strapping pin: low or floating at reset
is what the ESP32 wants, so the pull-down is the right resistor, and the firmware should only drive it high once it has
started.

## CNCjs widget

The package ships a small [custom widget](https://github.com/cncjs/cncjs-widget-boilerplate) for CNCjs (source in
`widget/`, built output in `widget/dist`). Collapsed, it is one row: a handwheel icon coloured by the link state and a
short status line. Expanded (fullscreen, or the button in the widget) it adds machine position, handwheel, CNCjs and
jog statistics and a live tail of the handwheel log.

| Icon colour | Meaning |
|---|---|
| green | handwheel connected, CNCjs socket up and machine port open |
| amber | handwheel connected, but CNCjs is unreachable or the machine port is closed |
| red | handwheel not connected |
| grey | the widget cannot reach the bridge at all, or the handwheel is plugged in but switched off (needs `device.power`) |

The widget runs in your browser, not on the Pi, so it cannot use the bridge's `127.0.0.1:8001` directly. Two pieces
are needed, both on the machine that runs CNCjs.

**1. Serve the widget from CNCjs** with its `--mount` option. `cncjs-handwheel --widget-path` prints the directory:

    cncjs --mount /handwheel:"$(cncjs-handwheel --widget-path)"

(Add it to the arguments of your CNCjs service. The path changes when npm updates the package, so keep the
`$(...)` form or restart CNCjs after an update.)

**2. Forward the API through your reverse proxy**, under the same host as CNCjs so there is no CORS or mixed
content. With Caddy:

    handle_path /handwheel-api/* {
        reverse_proxy 127.0.0.1:8001
    }

The bridge stays on loopback. Anything that reaches that route can read `/status` and `/log` (no secrets, but
pendant log lines and the machine state), so put it behind the same access control as CNCjs.

Then in CNCjs choose *Manage Widgets*, add a *Custom* widget and set its URL to `/handwheel/`.

URL parameters (append them to the widget URL, e.g. `/handwheel/?theme=dark`):

| Parameter | Default | |
|---|---|---|
| `api` | `/handwheel-api` | URL path of the proxied bridge |
| `theme` | auto | `light` or `dark`; forces the widget's own light or dark colours and stops it from following CNCjs. By default (see below) it follows CNCjs |
| `mode` | | `full` starts expanded |
| `debug` | | `1` adds an expand/collapse button (normally the details show only while CNCjs shows the widget fullscreen) |
| `poll` | `400` | how often the widget asks the bridge, in ms (at least 200) |

**Colours.** Served from the same origin as CNCjs, the widget takes its light/dark mode (`data-color-mode` on
`<html>`) and its colours from CNCjs's own theme tokens (`--color-surface`, `--color-widget-header-bg`,
`--color-status-danger-text`, ... see `widget/src/hostTheme.js` for the mapping) and follows a mode change live. CNCjs has no green
token, so the OK green is the widget's own. Where it cannot read the page (cross-origin, such as the Vite dev server) or
CNCjs lacks a token, the widget's own light and dark stylesheet applies.

**Fullscreen.** When the widget is served from the same origin as CNCjs (the setups above), it watches CNCjs's
widget container and expands and collapses with CNCjs's own fullscreen button; its own expand button then hides.
Fullscreen, the log pane takes the height that is left, so the CNCjs widget only scrolls when the screen is too short for the cards. This relies on the CSS class CNCjs puts on a fullscreen widget, so a CNCjs refactor can break it; the widget then
just keeps its own expand button. Where the widget is cross-origin (the Vite dev server) it cannot look at the
page, so use the expand button or `?mode=full`. A sturdier alternative is `tools/cncjs-custom-widget-fullscreen.diff`
(11 lines in the CNCjs `Custom` widget): the patched CNCjs posts the fullscreen state to the widget, which listens
for it in every setup. It is optional.

**Developing the widget.** `npm run dev:widget` starts a Vite dev server that forwards `/handwheel-api` to a bridge
on `127.0.0.1:8001` (override with `HANDWHEEL_BRIDGE=http://host:port`). `npm run build:widget` builds `widget/dist`;
`npm publish` does that first (`prepublishOnly`), so the published package contains the built widget and the Pi
needs no build tools.

## Pendant protocol

Newline-terminated text. Everything except log lines must be printable ASCII.

Pendant to bridge:

| Line | Effect |
|---|---|
| `G21G91X+10F2000` | jog (sent as `$J=...`); any other line is sent to the controller as gcode |
| `!` / `~` / `^X` (0x18) | feed hold / cycle start / reset, each as a line of its own (reset at most once per 2 s) |
| `0x85` (the single byte, as a line of its own) or `JOGCANCEL` | cancel the jog in progress (Grbl only), see "Jog cancel" below |
| `?` or `STATUS?` | immediate status line |
| `PING` | answered with `PONG` |
| `; text` | console log entry for the widget; never sent to the controller |
| `[HW:bat=74,chg=0,eta=13200,st=ok]` | the pendant's own state for the widget, never sent to the controller. `bat` battery 0-100 %, `chg` 1 while charging, `eta` seconds until full (charging) or empty, `st` `ok`, `warn` or `err` (the widget then says "Check log"). Every key is optional (a key left out counts as unknown), unknown keys are ignored. Send it when something changes and at least every 30 s; it is dropped when the pendant disconnects |

Bridge to pendant:

| Line | Meaning |
|---|---|
| `<Idle\|MPos:x,y,z\|WPos:x,y,z\|FS:feed,spindle>` | status: at most about 3 per second, at least every 400 ms, and shortly after every command |
| `<Disconnected>` | the bridge is up, but CNCjs or the CNC port is not |
| `ERR:CNCJS_NOT_READY` | a command was dropped because the CNC port is not open |
| `PONG` | answer to `PING` |

The status right after a command shows where the machine was at that moment; Grbl's `ok` only means the move was
queued. A fresh report follows within a few hundred milliseconds, and the status stream (about 3 lines per second while
the machine moves) tracks the move. If no line arrives for about 1 second, treat the bridge as gone.

## Troubleshooting

- **CNCjs restarted or was down for a while.** The bridge rebuilds its connection by itself (new socket, new access
  token, backoff of 1 to 10 s) and reattaches to the CNC port; the console shows `Disconnected`, `Reconnecting in ...`,
  `Connected to ws://...` and `Connected to port ...`. No restart of the bridge is needed. Nothing is queued while the
  connection is down, so a stale jog is never replayed afterwards.
- **`Controller did not acknowledge N gcode line(s)`.** Grbl never answered lines CNCjs was given, so they were most
  likely lost on the way (serial buffer overflow, cable or adapter trouble). Jogs are merged and limited by
  `jog.maxInFlight` to avoid this; if it still happens, lower it (try `2`). `/status` shows the counters under `jog`
  (`sent`, `merged`, `discarded`, `stalls`, `inFlight`, `held`).
- **Commands from the pendant have no effect.** Look for `Dropped pendant command (...)` in the console. It says whether
  the bridge is not connected to CNCjs or the CNC port is not open, and `/status` counts them in
  `cncjs.droppedCommands`. The pendant also receives `ERR:CNCJS_NOT_READY`. If the bridge claims everything is fine but
  CNCjs still ignores commands, the CNCjs log contains `Serial port "..." not accessible`.

- **ESP32 reboots or enters download mode when the port is opened.** Linux raises DTR and RTS on the first open, and
  the auto-reset circuit turns that into a reset. Use the udev rule from `--usb-port`. A capacitor of about 1 uF from
  EN to GND on the board removes the problem at its source.
- **Nothing from the pendant.** Run with `-v`. Lines rejected as non-text are reported as `dropped non-text line`
  and counted in `/status` (`pendant.garbageLines`); wrong baud rate and a rebooting ESP32 look like that.
- **The widget's log pane stays empty.** The pane shows the pendant's *log lines* only: lines that start with a
  semicolon (`; text`). It also says how many lines the bridge has received and how many of them were log lines
  (`/status` has the same numbers as `pendant.rxLines` and `pendant.logLines`; `/log` has the entries). Lines
  without the semicolon are not log lines: the bridge sends them to the controller as gcode, so a firmware that
  prints debug text on the same serial port must prefix it with `;`. Output from before the port settled
  (`device.settleMs`) is discarded.
- **`$$` and `$I` output at start.** Normal: CNCjs queries the controller when a client opens the CNC port.
- **No WPos.** Grbl reports the work offset only every 10-30 status reports; the first WPos can take a few seconds.

## Testing without hardware (pendant simulator)

`tools/pendant-sim.js` emulates the handwheel on a serial port, so you can exercise the bridge from a dev machine (it lives in the repository only; it is not part of the npm package).

Create a virtual serial pair and start the bridge on one end:

```bash
socat -d -d pty,raw,echo=0,link=/tmp/pendant-sim pty,raw,echo=0,link=/tmp/pendant-bridge
cncjs-handwheel --pendant-port /tmp/pendant-bridge -v
```

Then attach the simulator to the other end:

```bash
node tools/pendant-sim.js --port /tmp/pendant-sim
```

Interactive keys: arrows = X/Y jog, PgUp/PgDn (or `u`/`j`) = Z jog, `1`-`4` = step 1/0.1/0.01/0.001, `h` = `$H`, space = `!`, `r` = `~`, `X` = Ctrl-X, `?`, `p` = PING, `l` = log line, `b` = burst of jogs in the last direction, `q` = quit. The status line shows state, WPos, tx/rx counters and the age of the last status.

Script mode runs unattended and prints a one-line `SUMMARY`:

```bash
node tools/pendant-sim.js --port /tmp/pendant-sim --script "step:0.1, x+*500@500, wait:500, home, hold, resume"
```

Tokens: `x+ x- y+ y- z+ z-`, `x+*200@100` (200 jogs at 100/s), `step:N`, `feed:N`, `home hold resume reset status ping cancel`, `log:text`, `raw:LINE`, `wait:MS`.

## Quieting the CNCjs console

Every line the bridge sends goes through the CNCjs *feeder*, and CNCjs echoes feeder lines in its Console widget as `feeder> ...`
(lines of a G-code file are not echoed, because the sender never emits `serialport:write`). The bridge tags jogs with
`{echo: false}` in the command context; CNCjs passes the context along, so the Console widget can skip them with one check in
`src/app/widgets/Console/index.jsx`:

```js
'serialport:write': (data, context) => {
    const { source, __sender__ } = { ...context };
    if (__sender__ === this.senderId) { return; }
    if (context && context.echo === false) { return; }   // <- jogs from the handwheel bridge
    ...
```

Two other sources of console noise can be reduced from the bridge's side:
- `client> ?` and the `<Jog|MPos...>` reply come from the status request the bridge sends after pendant commands.
  Set `status.pollAfterCommand` to `false`; CNCjs polls the controller by itself and the pendant still gets status lines.
- The `ok` for every jog is echoed by CNCjs (`serialport:read`); only a console filter can hide those.

## Jog cancel

For real jogging the pendant sends one long jog when the wheel or button starts (`$J=G21G91X1000F2000`) and a jog cancel when
it stops. Send the single byte `0x85` followed by a newline (or the text line `JOGCANCEL`). The bridge then

1. discards a jog the governor is holding back,
2. sends CNCjs `feeder:stop`, which empties CNCjs's own queue so no further jog line leaves for Grbl (Grbl's cancel flushes
   only Grbl's planner; jogs still waiting in CNCjs would start again afterwards),
3. after `jog.cancelSettleMs` sends CNCjs `jogCancel`, which writes the realtime byte `0x85` to Grbl. Grbl acts on `0x85` the
   moment it arrives, ahead of lines still unparsed in its serial buffer, so the short wait lets those be parsed first;
   without it a long jog sent just before the cancel could start after it.

Jogs that arrive during that wait are held and released after the cancel. Lines CNCjs had already written to Grbl may still
run: with the governor that is at most `jog.maxInFlight` short jogs. Jog cancel is Grbl only and needs a CNCjs that knows the
`jogCancel` command (1.11 or a fork based on it). `/status` counts cancels under `jog.cancels`.
