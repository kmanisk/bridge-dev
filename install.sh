#!/bin/sh
# BridgeDev portable installer: a single command, no sudo, no service changes.
set -eu
umask 077
say(){ printf '[BridgeDev] %s\n' "$*"; }
die(){ printf '[BridgeDev] ERROR: %s\n' "$*" >&2; exit 1; }
command -v node >/dev/null 2>&1 || die 'Node.js 22+ is required; install Node.js and retry.'
command -v npm >/dev/null 2>&1 || die 'npm is required alongside Node.js.'
command -v tar >/dev/null 2>&1 || die 'tar is required.'
command -v curl >/dev/null 2>&1 || die 'curl is required.'
[ "$(node -p 'Number(process.versions.node.split(".")[0]) >= 22')" = true ] || die 'Node.js 22+ is required.'
[ "$(id -u)" -ne 0 ] || [ "${BRIDGEDEV_INSTALL_TEST_ROOT:-}" = 1 ] || die 'Install as a normal user, not with sudo.'
if [ -n "${BRIDGEDEV_INSTALL_SOURCE_DIR:-}" ]; then
  exec node "$BRIDGEDEV_INSTALL_SOURCE_DIR/scripts/install-portable.mjs" --source "$BRIDGEDEV_INSTALL_SOURCE_DIR"
fi
tmp=$(mktemp -d "${TMPDIR:-/tmp}/bridge-dev-install.XXXXXXXX") || die 'Could not create a temporary directory.'
trap 'rm -rf -- "$tmp"' 0
trap 'exit 1' 1 2 3 15
say 'Downloading source from GitHub...'
curl --fail --silent --show-error --location --retry 2 --max-time 120 \
  https://github.com/kmanisk/bridge-dev/archive/refs/heads/main.tar.gz -o "$tmp/source.tar.gz" || die 'Download failed.'
tar -tzf "$tmp/source.tar.gz" | grep -q '^bridge-dev-main/package.json$' || die 'Invalid archive.'
tar -xzf "$tmp/source.tar.gz" -C "$tmp" || die 'Extraction failed.'
[ -f "$tmp/bridge-dev-main/scripts/install-portable.mjs" ] || die 'Missing installer.'
node "$tmp/bridge-dev-main/scripts/install-portable.mjs" --source "$tmp/bridge-dev-main"
