#!/usr/bin/env bash
# Installs (or removes) the CNCjs ESP32 handwheel bridge as a systemd service.
#   sudo bash deploy/install.sh [--user USER] [--usb-port 1-2:1.0] [--prefix DIR] [--start]
#   sudo bash deploy/install.sh --uninstall
set -euo pipefail

SERVICE=cncjs-handwheel
PREFIX=/usr/lib/node_modules/cncjs-handwheel
RUN_USER="${SUDO_USER:-}"
KERNELS=""
START=0
UNINSTALL=0
UNIT="/etc/systemd/system/${SERVICE}.service"
RULE=/etc/udev/rules.d/99-cncjs-handwheel.rules

usage() {
    cat <<USAGE
Usage: sudo bash $0 [options]
  --user USER       user the service runs as; must be the user that runs CNCjs, because the
                    secret is read from that user's ~/.cncrc (default: \$SUDO_USER)
  --usb-port PORT   USB port the handwheel is plugged into (the KERNELS value from
                    'udevadm info -a -n /dev/ttyUSBx | grep KERNELS', e.g. 1-2:1.0).
                    Installs a udev rule giving /dev/pendant and a reset-safe port setup.
  --prefix DIR      install location (default: $PREFIX)
  --start           start the service now (otherwise: edit the config first)
  --uninstall       remove service, udev rule and program files (config is kept)
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --user) RUN_USER="$2"; shift 2 ;;
        --prefix) PREFIX="$2"; shift 2 ;;
        --usb-port) KERNELS="$2"; shift 2 ;;
        --start) START=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
    esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo "Please run with sudo." >&2
    exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
    systemctl disable --now "$SERVICE" 2>/dev/null || true
    rm -f "$UNIT" "$RULE"
    rm -rf "$PREFIX"
    systemctl daemon-reload
    udevadm control --reload 2>/dev/null || true
    echo "Removed. Your config file (~/.cncjs-handwheel.config) was left in place."
    exit 0
fi

if [ -z "$RUN_USER" ] || [ "$RUN_USER" = root ]; then
    echo "Cannot tell which user should run the service. Use --user USER (the user running CNCjs)." >&2
    exit 1
fi
id "$RUN_USER" >/dev/null 2>&1 || { echo "No such user: $RUN_USER" >&2; exit 1; }
HOME_DIR="$(getent passwd "$RUN_USER" | cut -d: -f6)"
CONFIG="$HOME_DIR/.cncjs-handwheel.config"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Node: use the one the service user gets in a login shell (handles nvm / NodeSource installs)
NODE="$(sudo -u "$RUN_USER" bash -lc 'command -v node' 2>/dev/null | tail -n1 || true)"
[ -n "$NODE" ] || NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js not found. Install Node 20 or newer first." >&2; exit 1; }
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "Node $NODE_MAJOR found at $NODE, but 20 or newer is required." >&2
    exit 1
fi
NPM="$(dirname "$NODE")/npm"
echo "Using Node $("$NODE" -v) at $NODE"

echo "Installing to $PREFIX"
if [ "$SRC" != "$PREFIX" ]; then
    mkdir -p "$PREFIX"
    tar -C "$SRC" --exclude=node_modules -cf - . | tar -C "$PREFIX" -xf -
fi
chmod +x "$PREFIX/bin/cncjs-handwheel"
(cd "$PREFIX" && PATH="$(dirname "$NODE"):$PATH" "$NPM" install --omit=dev --no-audit --no-fund)

if [ ! -e "$CONFIG" ]; then
    install -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" -m 644 "$PREFIX/cncjs-handwheel.config.example.json" "$CONFIG"
    echo "Created $CONFIG from the example. Edit it before starting."
else
    echo "Keeping existing $CONFIG"
fi

if [ -n "$KERNELS" ]; then
    cat > "$RULE" <<RULE_EOF
# CNCjs handwheel: stable name, no ModemManager probing, and a port setup that does not
# drop DTR/RTS (which would reset the ESP32 through its auto-reset circuit).
SUBSYSTEM=="tty", ACTION=="add", KERNELS=="$KERNELS", SYMLINK+="pendant", ENV{ID_MM_DEVICE_IGNORE}="1", RUN+="/bin/stty -F /dev/%k 115200 raw -echo -crtscts -hupcl"
RULE_EOF
    udevadm control --reload
    echo "Installed $RULE (replug the pendant; then use /dev/pendant as device.path)"
fi

sed -e "s|@USER@|$RUN_USER|g" -e "s|@PREFIX@|$PREFIX|g" -e "s|@NODE@|$NODE|g" -e "s|@CONFIG@|$CONFIG|g" \
    "$PREFIX/deploy/cncjs-handwheel.service" > "$UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE"

if [ "$START" -eq 1 ]; then
    systemctl restart "$SERVICE"
    echo "Started."
else
    echo "Not started yet. After editing $CONFIG run: sudo systemctl start $SERVICE"
fi
echo "Logs:   journalctl -u $SERVICE -f"
echo "Health: curl http://127.0.0.1:8001/status"
