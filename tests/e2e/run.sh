#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# End-to-end test in a nested GNOME Shell (needs mutter-dev-bin; run it on a GNOME desktop):
#   npm run e2e                    capsule, live activities, daemon crash and restart
#   E2E_KEYBOARD=1 npm run e2e     also the shortcut and tab navigation (keep the window visible)
#
# It starts the extension in an isolated nested Shell with synthetic Claude transcripts, then
# drives and inspects it through the development debug service (src/dev, never packaged): the
# capsule text, live activities, the keyboard shortcut and tabs, and a daemon crash and restart.
# Nothing touches the real session, the real ~/.claude, or the real state directories.
# These helpers are run indirectly, by wait_for.
# shellcheck disable=SC2317,SC2329
set -uo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
log="$work/shell.log"
failures=0
trap 'pkill -f "^gnome-shell --devkit" 2>/dev/null; rm -rf "$work"' EXIT

pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n        %s\n' "$1" "$2"; failures=$((failures + 1)); }
debug() { "$root/scripts/dev-debug.sh" "$@"; }
field() { debug state | python3 -I -c "import json,sys; print(json.load(sys.stdin)$1)"; }
check() { # check NAME ACTUAL EXPECTED
    if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$3], got [$2]"; fi
}
check_match() { # check_match NAME ACTUAL REGEX
    if [[ "$2" =~ $3 ]]; then pass "$1"; else fail "$1" "expected /$3/, got [$2]"; fi
}
wait_for() { # wait_for SECONDS COMMAND...   (retries until the command succeeds)
    local deadline=$((SECONDS + $1)); shift
    while ! "$@" >/dev/null 2>&1; do [ $SECONDS -ge $deadline ] && return 1; sleep 0.3; done
}
shown() { field "['shownText']"; }
shown_is() { [[ "$(shown)" == "$1" ]]; }
shown_starts() { [[ "$(shown)" == "$1"* ]]; }
available() { [ "$(field "['available']")" = True ]; }
unavailable() { [ "$(field "['available']")" = False ]; }

if ! command -v gnome-shell >/dev/null || [ ! -x /usr/libexec/mutter-devkit ]; then
    echo "needs gnome-shell and mutter-dev-bin"
    exit 2
fi
(cd "$root" && npm run -s build) || exit 2

# Synthetic transcripts: 1,000 fresh tokens today.
now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
mkdir -p "$work/claude/projects/-demo"
printf '{"type":"assistant","sessionId":"e2e","timestamp":"%s","message":{"id":"m1","model":"claude-test","usage":{"input_tokens":100,"cache_creation_input_tokens":300,"cache_read_input_tokens":9000,"output_tokens":600}}}\n' "$now" > "$work/claude/projects/-demo/e2e.jsonl"

rm -rf "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/state"
# Animations off: they only advance while the nested window is painted, and this also exercises
# the "reduce animation" path (the capsule must still end at the right size).
(cd "$root" && CLAUDE_CONFIG_DIR="$work/claude" ISLET_NESTED_NO_ANIMATIONS=1 setsid nohup scripts/nested.sh > "$log" 2>&1 &)
wait_for 90 debug state || { echo "the nested Shell did not start"; tail -n 20 "$log"; exit 2; }
sleep 2

echo "capsule and usage"
wait_for 20 shown_is 'Claude 1.00K' ; check "today's fresh tokens from the transcripts" "$(shown)" "Claude 1.00K"
check "the daemon is available" "$(field "['available']")" "True"
clock_centre="$(field "['clock']['center']")"; stage_half="$(( $(field "['stageWidth']") / 2 ))"
check "the clock stays centred" "$clock_centre" "$stage_half"

echo "plan usage and live activities"
t=$(date +%s)
debug call ReportPlanUsage "{'five_hour_used_percentage': 33.0, 'five_hour_resets_at': $((t + 3600)).0}" >/dev/null
wait_for 10 shown_is 'Claude 1.00K · 33%' ; check "plan percentage in the capsule" "$(shown)" "Claude 1.00K · 33%"
debug call ReportAgentEvent "{'session_id': 'x', 'cwd': '/home/me/code/web', 'hook_event_name': 'Notification', 'notification_type': 'permission_prompt'}" >/dev/null
wait_for 5 shown_is 'web needs your permission' ; check "permission live activity" "$(shown)" "web needs your permission"
check "the clock still centred during a live activity" "$(field "['clock']['center']")" "$stage_half"
wait_for 10 shown_is 'web needs permission' ; check "then the persistent compact view" "$(shown)" "web needs permission"
debug call ReportAgentEvent "{'session_id': 'x', 'cwd': '/home/me/code/web', 'hook_event_name': 'Stop'}" >/dev/null
wait_for 10 shown_is 'Claude 1.00K · 33%' ; check "back to usage once the session finished" "$(shown)" "Claude 1.00K · 33%"

if [ -n "${E2E_KEYBOARD:-}" ]; then
    # Keyboard input is only dispatched while the nested window is painted (an occluded
    # window's frame clock is throttled), so this part needs the window to stay on top.
    echo "keyboard (the nested window must be visible)"
    debug keys Control_L+Alt_L+space; sleep 0.8
    check "the shortcut opens the island" "$(field "['menuOpen']")" "True"
    check "focus lands on the Claude tab" "$(field "['keyFocus']")" "St_Button:islet-tab:Claude"
    debug keys Right; sleep 0.4; check "Right switches to Music" "$(field "['page']")" "media"
    debug keys Right; sleep 0.4; check "Right switches to Focus" "$(field "['page']")" "focus"
    debug keys Escape; sleep 0.6; check "Escape closes" "$(field "['menuOpen']")" "False"
else
    echo "keyboard: skipped (set E2E_KEYBOARD=1 and keep the nested window visible)"
fi

echo "daemon crash and restart"
pkill -9 -f '[d]aemon/main\.js'
wait_for 8 unavailable; check "the capsule greys out" "$(field "['available']")" "False"
wait_for 20 available; check "the daemon comes back by itself" "$(field "['available']")" "True"
wait_for 10 shown_starts 'Claude 1.00K'; check_match "usage is back after the restart" "$(shown)" '^Claude 1\.00K'

echo "log"
errors="$(grep -cE 'JS ERROR' "$log" || true)"
check "no JS errors in the Shell log" "$errors" "0"

echo
if [ "$failures" -eq 0 ]; then echo "e2e: all checks passed"; else echo "e2e: $failures check(s) failed"; fi
exit "$((failures > 0))"
