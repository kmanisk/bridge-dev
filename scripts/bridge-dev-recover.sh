#!/bin/sh
# BridgeDev managed Linux operator recovery. No install, no service restart.
# Run locally in your own terminal; never through MCP or with sudo sh.
set -eu

CLI=/usr/local/bin/bridge-dev
OPERATOR=/opt/bridge-dev/scripts/policygate-operator.mjs

say() { printf '[BridgeDev] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: sh bridge-dev-recover.sh [check | on [minutes] | off]
  check       Read-only status (default); never prompts for sudo
  on 60       Request a time-limited Full System lease (1-120 min)
  off         Revoke Full System and return to Read & Write
This file does not install, update, restart, or deploy BridgeDev.
Managed service releases use their separate, watchdog-backed deploy controller.
USAGE
}
need_host() {
  [ "$(uname -s)" = Linux ] || die "Managed mode is Linux-only"
  [ -x "$CLI" ] || die "Managed CLI missing at $CLI"
  [ -f "$OPERATOR" ] || die "Managed operator script missing at $OPERATOR"
  [ -x /usr/bin/node ] || die "Node missing at /usr/bin/node"
  command -v sudo >/dev/null 2>&1 || die "sudo is unavailable"
}
operator_status() {
  sudo /usr/bin/node "$OPERATOR" status
}
active_lease() {
  case "$1" in
    *"Current Mode : FULL SYSTEM / sudo ("*) return 0 ;;
    *) return 1 ;;
  esac
}
check() {
  say "Selected managed CLI: $CLI"
  selected=$(command -v bridge-dev 2>/dev/null || :)
  if [ -n "$selected" ] && [ "$selected" != "$CLI" ]; then
    say "Your PATH selects $selected instead; using the managed CLI explicitly."
  fi
  "$CLI" mode status || :
  say "Local CLI state alone does not prove gateway root authorization."
  say "Verify MCP agent_status returns full_machine_access=true before relying on sudo."
  say "Read-only check complete. No mode or service changes."
}
rollback() {
  say "Activation was not verified; attempting operator-controlled rollback to Read & Write."
  if "$CLI" mode sudo --off; then
    if result=$(operator_status); then
      printf '%s\n' "$result"
      if ! active_lease "$result"; then
        say "Rollback verified by independent operator status."
        return 0
      fi
    fi
  fi
  say "ROLLBACK UNVERIFIED. Inspect the operator/controller and existing jobs; do not retry activation."
  return 1
}
activate() {
  duration=${1:-60}
  case "$duration" in
    ''|*[!0-9]*) die "Duration must be an integer from 1 to 120" ;;
  esac
  [ "$duration" -ge 1 ] && [ "$duration" -le 120 ] || die "Duration must be 1-120 minutes"
  [ -t 0 ] && [ -t 1 ] || die "Activation requires an independent interactive local terminal"
  say "Checking independent operator state first; no existing lease will be overwritten."
  before=$(operator_status) || die "Cannot verify operator status; no activation attempted"
  printf '%s\n' "$before"
  if active_lease "$before"; then
    die "An existing Full System lease is active. Check/revoke it first; no new lease issued."
  fi
  say "Requesting Full System for $duration minute(s). The operator will ask you to confirm."
  # Old CLI builds can return nonzero when root-owned lease metadata is not
  # readable by the ordinary user. Do not trust that exit code alone.
  cli_code=0
  "$CLI" mode sudo --duration "$duration" || cli_code=$?
  if ! after=$(operator_status); then
    rollback || :
    die "Operator status unavailable after request; lease cannot be considered verified"
  fi
  printf '%s\n' "$after"
  if ! active_lease "$after"; then
    # If user declined, no new lease exists; still leave the base mode as-is.
    if [ "$cli_code" -eq 0 ]; then
      say "No Full System lease was issued (possibly declined)."
      exit 1
    fi
    rollback || :
    die "Activation failed and rollback was attempted"
  fi
  if [ "$cli_code" -ne 0 ]; then
    say "CLI returned $cli_code, but the independent operator reports a signed active lease."
    say "This may be a stale/unreadable CLI status, not proof of gateway acceptance."
  fi
  say "Operator lease VERIFIED. Remote gateway acceptance is still UNVERIFIED."
  say "Check MCP agent_status for full_machine_access=true. If absent, run: sh bridge-dev-recover.sh off"
}
deactivate() {
  [ -t 0 ] && [ -t 1 ] || die "Deactivation requires an independent local terminal"
  say "Revoking Full System using the managed operator."
  "$CLI" mode sudo --off || die "Revoke command failed; inspect operator status and existing jobs"
  after=$(operator_status) || die "Revoke requested, but independent status is unavailable"
  printf '%s\n' "$after"
  if active_lease "$after"; then
    die "Full System still active; do not assume revocation"
  fi
  say "Full System inactive according to the operator. Confirm MCP agent_status reports full_machine_access=false."
}

case "${1:-check}" in
  --help|-h|help) usage ;;
  check) [ "$#" -eq 1 ] || [ "$#" -eq 0 ] || die "Unexpected arguments"; need_host; check ;;
  on) [ "$#" -le 2 ] || die "Unexpected arguments"; need_host; activate "${2:-60}" ;;
  off) [ "$#" -eq 1 ] || die "Unexpected arguments"; need_host; deactivate ;;
  *) usage; die "Unknown action: $1" ;;
esac
