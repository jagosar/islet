# Changelog

## 0.1.0 — 2026-10-16

First release, for GNOME Shell 50.

### Added

- The capsule next to the clock, with the clock kept centred, and live activities for agent
  events, plan thresholds (75 % and 90 % of the 5-hour window), focus endings and new songs.
- Claude Code usage from local transcripts: today's fresh and processed tokens per model,
  de-duplicated per response and reconciled with Claude Code's own totals when a session ends;
  a 26-week usage graph.
- Live Claude Code sessions from hooks (terminal, desktop app and VS Code): needs permission,
  waiting, working, finished.
- Plan usage (5-hour and weekly) from the status line of terminal sessions, chaining an existing
  status line.
- Music from any MPRIS player, and a focus timer with a 7-day history.
- Preferences: connect or disconnect Claude Code (backup, exact preview, byte-exact undo) and the
  keyboard shortcut (`Ctrl+Alt+Space` by default).
- `install.sh` and `uninstall.sh` for a per-user install without root.
