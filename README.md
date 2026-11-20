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
Start from `cncjs-pendant.config.example.json`.

| Key | Meaning |
|---|---|
| `cncjs.port` | CNC controller port as CNCjs knows it (not the pendant) |
| `cncjs.controllerType` | `Grbl` (Smoothie shares the state format) |
| `device.path` | pendant serial port: `/dev/pendant` (USB, with the udev rule) or `/dev/rfcomm0` (Bluetooth) |
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
