#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# End-to-end test in a nested GNOME Shell (needs mutter-dev-bin; run it on a GNOME desktop):
#   npm run e2e                    capsule, live activities, daemon crash and restart
#   E2E_KEYBOARD=1 npm run e2e     also the shortcut, tab navigation and painted bars (keep the window visible)
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
# Only the nested Shell's daemon (run from the sandbox): an Islet installed in the real session
# has its own daemon, which these tests must neither count nor kill.
nested_daemon='[i]slet-devkit/data/gnome-shell/extensions/.*/daemon/main\.js'
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

rm -rf "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/state" "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/config/Claude"
# The Claude desktop app is "installed": its folder exists, its plan history does not yet.
mkdir -p "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/config/Claude"
# Animations off: they only advance while the nested window is painted, and this also exercises
# the "reduce animation" path (the capsule must still end at the right size).
(cd "$root" && CLAUDE_CONFIG_DIR="$work/claude" ISLET_NESTED_NO_ANIMATIONS=1 setsid nohup scripts/nested.sh > "$log" 2>&1 &)
wait_for 90 debug state || { echo "the nested Shell did not start"; tail -n 20 "$log"; exit 2; }
sleep 2

echo "capsule and usage"
wait_for 20 shown_is 'Claude 1.00K' ; check "today's fresh tokens from the transcripts" "$(shown)" "Claude 1.00K"
check "the daemon is available" "$(field "['available']")" "True"
check "one tab per subject: Claude, Music, Focus" "$(field "['pages']")" "['claude', 'media', 'focus']"
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

echo "plan usage from the desktop app and from a limit message"
desktop="${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/config/Claude"
mkdir -p "$desktop"
printf '{"version":2,"samples":[{"t":%s,"org":"e2e","u":{"fh":61,"sd":22}}]}' "$(date +%s%3N)" > "$desktop/history.tmp"
mv "$desktop/history.tmp" "$desktop/plan-usage-history.json"
wait_for 10 shown_is 'Claude 1.00K · 61%' ; check "the desktop app's plan figure in the capsule" "$(shown)" "Claude 1.00K · 61%"
# The bars once stayed empty after the panel was closed and opened again (the fill was sized from
# a width that had not settled yet). They are painted from their width now. A nested window gets
# its layout and paint only while the host draws it, so these checks are in the part that needs
# the window visible (E2E_KEYBOARD=1).
bars_are() { # bars_are FIVE_HOUR WEEKLY: both bars >= 100 px wide, each filled with its share (+/- 1 px)
    field "['planBars']" | python3 -I -c "
import ast, sys
bars = ast.literal_eval(sys.stdin.read()); want = [int(sys.argv[1]), int(sys.argv[2])]
ok = len(bars) == 2 and all(b['width'] >= 100 and abs(b['measured'] - round(b['width'] * w / 100)) <= 1 for b, w in zip(bars, want))
print('ok' if ok else bars)" "$1" "$2"
}
bars_ok() { [ "$(bars_are "$1" "$2")" = ok ]; }
reset_at=$(( $(date +%s) + 7200 ))
reset_clock="$(TZ=UTC date -d "@$reset_at" +%-l:%M%P)"
printf '{"type":"assistant","sessionId":"e2e","timestamp":"%s","isApiErrorMessage":true,"error":"rate_limit","apiError":"usage_limit_reached","message":{"id":"limit","model":"<synthetic>","content":[{"type":"text","text":"You'"'"'ve hit your session limit · resets %s (UTC)"}]}}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$reset_clock" >> "$work/claude/projects/-demo/e2e.jsonl"
wait_for 10 shown_is 'Claude 1.00K · 100%' ; check "a limit message puts the plan at 100%" "$(shown)" "Claude 1.00K · 100%"

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
    # The regression: after being closed and opened again, the bars were left at a stale width.
    debug keys Control_L+Alt_L+space; wait_for 8 bars_ok 100 22
    check "the plan bars are filled when the panel is reopened" "$(bars_are 100 22)" "ok"
    debug keys Escape; sleep 0.6
else
    echo "keyboard and painted bars: skipped (set E2E_KEYBOARD=1 and keep the nested window visible)"
fi

echo "daemon crash and restart"
pkill -9 -f "$nested_daemon"
wait_for 8 unavailable; check "the capsule greys out" "$(field "['available']")" "False"
wait_for 20 available; check "the daemon comes back by itself" "$(field "['available']")" "True"
wait_for 10 shown_starts 'Claude 1.00K'; check_match "usage is back after the restart" "$(shown)" '^Claude 1\.00K'

echo "the estimate between two measurements"
# Measurements every 15 minutes rising 8 points per $4 used (2 points per dollar), then $2 more
# after the last one (40 %): the capsule leads with the estimate, "≈44%".
iso() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z; }
request() { # request MINUTES_AGO ID: a $1 response (Sonnet, 66,667 output tokens)
    printf '{"type":"assistant","sessionId":"est","timestamp":"%s","message":{"id":"est%s","model":"claude-sonnet-5-5","usage":{"output_tokens":66667}}}\n' "$(iso $((est_now - $1 * 60)))" "$2"
}
est_now=$(date +%s)
{
    id=0
    for m in 72 69 66 63  57 54 51 48  42 39 36 33  27 24 21 18  13 10 7 4; do id=$((id + 1)); request $m $id; done
    request 0 91   # after the last measurement
} >> "$work/claude/projects/-demo/est.jsonl"
# The measurements, the last of them a second ago (it must be newer than the limit message
# above, or it would be ignored as an older reading); and one more dollar right after it.
samples=""
for entry in "75 0" "60 8" "45 16" "30 24" "15 32"; do
    set -- $entry; samples="$samples{\"t\":$(( (est_now - $1 * 60) * 1000 )),\"org\":\"e2e\",\"u\":{\"fh\":$2,\"sd\":22}},"
done
samples="$samples{\"t\":$(( (est_now - 1) * 1000 )),\"org\":\"e2e\",\"u\":{\"fh\":40,\"sd\":22}}"
printf '{"version":2,"samples":[%s]}' "$samples" > "$desktop/history.tmp"
mv "$desktop/history.tmp" "$desktop/plan-usage-history.json"
request 0 92 >> "$work/claude/projects/-demo/est.jsonl"
estimate_shown() { [[ "$(shown)" =~ ^Claude\ [0-9.]+[KM]\ ·\ ≈4[3-5]%$ ]]; }
wait_for 15 estimate_shown ; check_match "the capsule shows the estimate with a tilde" "$(shown)" '^Claude [0-9.]+[KM] · ≈4[3-5]%$'
estimated_bar() { # the 5-hour bar: 40 % measured, the estimate (43 to 45 %) lighter after it
    field "['planBars']" | python3 -I -c "
import ast, sys
bar = ast.literal_eval(sys.stdin.read())[0]; w = bar['width']
ok = w >= 100 and abs(bar['measured'] - round(w * 0.40)) <= 1 and round(w * 0.03) - 1 <= bar['estimated'] <= round(w * 0.05) + 1
print('ok' if ok else bar)"
}
if [ -n "${E2E_KEYBOARD:-}" ]; then
    estimated_bar_ok() { [ "$(estimated_bar)" = ok ]; }
    debug keys Control_L+Alt_L+space; wait_for 8 estimated_bar_ok
    check "the bar shows the measured part and the estimate after it" "$(estimated_bar)" "ok"
    debug keys Escape; sleep 0.6
fi

echo "log"
errors="$(grep -cE 'JS ERROR' "$log" || true)"
check "no JS errors in the Shell log" "$errors" "0"

echo "enable() rolls back when it fails (a failure is injected at its end)"
pkill -f "^gnome-shell --devkit"; sleep 1
rm -rf "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/state" "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/config/Claude"
(cd "$root" && CLAUDE_CONFIG_DIR="$work/claude" ISLET_NESTED_NO_ANIMATIONS=1 ISLET_DEV_FAIL_ENABLE=1 setsid nohup scripts/nested.sh > "$work/fail.log" 2>&1 &)
bus_ready() { [ -s "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/bus-address" ] && grep -q "GNOME Shell started" "$work/fail.log"; }
wait_for 90 bus_ready || { echo "the nested Shell did not start"; tail -n 20 "$work/fail.log"; exit 2; }
sleep 3
extension_state() {
    gdbus call --address "$(cat "${XDG_RUNTIME_DIR:-/tmp}/islet-devkit/bus-address")" --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions --method org.gnome.Shell.Extensions.GetExtensionInfo islet@jagosar.github.io |
        grep -o "'state': <[0-9.]*>" | grep -o '[0-9.]*>' | tr -d '>'
}
check "GNOME Shell sees the failure (state ERROR)" "$(extension_state)" "3.0"
check "the daemon started by the failed enable() was stopped again" "$(pgrep -fc "$nested_daemon" || true)" "0"
check "the injected error is logged once" "$(grep -c 'Extension islet@jagosar.github.io: Error: ISLET_DEV_FAIL_ENABLE' "$work/fail.log" || true)" "1"
check "and nothing else fails (no error from disable())" "$(grep -c 'JS ERROR' "$work/fail.log" || true)" "0"

echo
if [ "$failures" -eq 0 ]; then echo "e2e: all checks passed"; else echo "e2e: $failures check(s) failed"; fi
exit "$((failures > 0))"
