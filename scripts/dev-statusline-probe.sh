#!/usr/bin/env bash
# Development only (spike S4): a Claude Code status line command that records when and where it
# runs, to learn whether the desktop app and VS Code call the status line at all.
#
# Each call appends one line to $XDG_RUNTIME_DIR/islet-devkit/statusline-probe.log with the
# time, the CLAUDE* environment variable names (values only for CLAUDE_CODE_ENTRYPOINT), the
# Claude Code version and the plan usage figures. No prompt, path or message content is logged.
# Needs jq.

log_dir="${XDG_RUNTIME_DIR:-/tmp}/islet-devkit"
mkdir -p "$log_dir"

input="$(cat)"
five_hour="$(jq -r '.rate_limits.five_hour.used_percentage // "-"' <<<"$input" 2>/dev/null)"
seven_day="$(jq -r '.rate_limits.seven_day.used_percentage // "-"' <<<"$input" 2>/dev/null)"
version="$(jq -r '.version // "-"' <<<"$input" 2>/dev/null)"
session="$(jq -r '.session_id // "-" | .[0:8]' <<<"$input" 2>/dev/null)"
env_names="$(env | cut -d= -f1 | grep '^CLAUDE' | sort | tr '\n' ',')"

printf '%s entrypoint=%s version=%s session=%s 5h=%s 7d=%s env=%s\n' \
    "$(date --iso-8601=seconds)" "${CLAUDE_CODE_ENTRYPOINT:--}" "$version" "$session" \
    "$five_hour" "$seven_day" "$env_names" >> "$log_dir/statusline-probe.log"

echo "Islet probe · 5h ${five_hour}% · 7d ${seven_day}%"
exit 0
