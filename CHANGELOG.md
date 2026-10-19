# Changelog

## Unreleased

### Added

- **The Claude tab now follows the Claude desktop app's usage panel:** the plan limits; this
  session's cost, active and API time, changed lines, model mix and cache hits, with tokens and
  cost per model; and what is using your limits over 24 hours or 7 days, from the attribution
  Claude Code records for its own `/usage` (MCP servers, skills, subagents, plugins) and
  behaviours such as long context, long sessions and parallel sessions.
- **Plan usage without a terminal session:** from the Claude desktop app's local history
  (`~/.config/Claude/plan-usage-history.json`) and from "You've hit your limit · resets …"
  messages, merged with the status line figures. A live activity also announces 100 %.

### Changed

- A plan figure is shown in the capsule for 30 minutes after it was measured (was 15).

### Removed

- The Claude tab's "today's tokens" block and the 26-week usage graph, which the new view makes
  redundant (today's total stays in the capsule). The sessions list stays, at the top of the tab,
  and only while an agent is running.

## 0.1.2 — 2026-10-17

Ready for extensions.gnome.org review; no change in behaviour.

### Changed

- The packaged extension no longer contains development hooks (the debug service and the
  environment switches used by the end-to-end tests): they are marked in the source and stripped
  when packaging, and a package test checks the result.
- One informational log line less; only warnings and errors are logged.

### Quality

- Package tests check the extensions.gnome.org import rules (no `Gtk`, `Gdk` or `Adw` in the Shell
  process, no `Clutter`, `Meta`, `St` or `Shell` in preferences) and that the stripped JavaScript
  is valid.
- Dependabot no longer proposes TypeScript major updates until typescript-eslint supports
  TypeScript 7 (it refuses to run on it today).
- Maintainers can enable a hook that keeps personal emails out of the public history
  (`npm run hooks`).

## 0.1.1 — 2026-10-17

A security fix and the robustness fixes from the first code audit. Upgrading is
`./install.sh` from the new archive; an existing Claude Code connection is updated by itself.

### Security

- The backup `settings.json.islet-backup` was created readable by every user of the computer
  (mode 0664) even when `settings.json` was private (0600), and `settings.json` can hold API keys.
  Files Islet creates are now private; a backup left by 0.1.0 is tightened when you open
  Preferences or run `./install.sh`. **If you connected Claude Code with 0.1.0, upgrade.**

### Fixed

- **Locking the screen no longer loses Claude Code events.** GNOME Shell switches extensions
  off while the screen is locked. Hooks and the status line now leave what they could not deliver
  in a private spool, which Islet replays when it starts, and sessions are saved and restored.
- A transcript line with invalid UTF-8 no longer stops usage tracking for that file.
- A failure while enabling the extension is undone completely; a daemon that cannot be started is
  retried instead of breaking the extension.
- The focus history lost a day's minutes after a time change (summer time).
- A status line command that hangs no longer leaves processes behind.
- A Claude Code connection that went out of date (Islet moved, or made by an older version) is
  now reported as **Needs repair** in Preferences, with a **Repair…** button and a `repair`
  command; `./install.sh` repairs it for you.

### Changed

- Plan usage is announced and saved when it changes, and otherwise once per 30 seconds, instead
  of on every status line run.
- Limits on what other programs can ask of Islet: rate limits on its D-Bus methods, at most 200
  tracked sessions, and a daily cleanup of what the 26-week graph no longer shows.

### Quality

- Integration, package and end-to-end tests, a coverage gate, strict type-aware lint, ShellCheck,
  a dependency audit and Dependabot, all in the CI pipeline. See `docs/TESTING.md`.

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

