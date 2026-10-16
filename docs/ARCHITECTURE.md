# Islet — Architecture and Decisions

> Working name. A small "dynamic island" for the GNOME top bar: Claude Code usage and live
> agent alerts, now playing and a focus timer, next to the clock. Local-first.
> Inspired by [Developer Island](https://github.com/maximilian467/Developer-Island) (Windows, MIT);
> no code is shared, only ideas.

Status: **draft, pre-spike**. Every decision below marked *(spike)* is validated by a prototype
before code is written in earnest.

---

## 1. Context and constraints

| Fact | Consequence |
|---|---|
| Target desktop is **GNOME Shell on Wayland** (dev machine: Ubuntu 26.04, GNOME 50.1, GJS 1.88) | See §2: a Shell extension is the only way to draw a panel-anchored capsule |
| Mutter does **not** implement `wlr-layer-shell`, and `xdg_toplevel` has no "always on top" | A normal app (GTK, Electron, Tauri) cannot pin itself to the top bar |
| An extension runs **inside the compositor** | A blocking call freezes the desktop; a fatal error can end the session |
| Goal: publish on GitHub for other people, possibly on extensions.gnome.org (EGO) | Must follow the [EGO review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html): readable JS, no binaries, scripts in GJS, clean `disable()` |
| User uses Claude Code (desktop app and VS Code) on a **subscription**, not Codex | Plan usage (5 h / 7 d) matters more than API-equivalent cost; Codex is out of v1 |
| UI language: English | Strings go through gettext from day one so others can translate |

## 2. Why a GNOME Shell extension (and not something else)

Options evaluated:

| Option | Verdict |
|---|---|
| GTK4 / Electron / Tauri window | **Rejected.** Cannot position itself or stay on top under GNOME Wayland |
| GTK4 + `gtk4-layer-shell` | **Rejected.** Works on wlroots/KDE only; Mutter has no layer-shell (upstream request still open, no plans) |
| X11 window under XWayland | **Rejected.** Fragile, no reliable stacking above Wayland windows, GNOME is removing X11 |
| Patched Shell / fork (e.g. Gnoblin) | **Rejected.** Not something we can ask users to install |
| **Shell extension (UI) + out-of-process daemon (data)** | **Chosen.** Only path to a native, panel-anchored UI; the daemon keeps heavy work out of the compositor |

## 3. Shape of the system

```
 Claude Code (CLI, desktop, VS Code)
   │  hooks (Notification, Stop, SessionStart/End, …)   statusLine (terminal sessions)
   ▼                                                     ▼
 islet-hook  ─────────┐                        islet-statusline
 (GJS, ~50 ms, exit 0)│                        (GJS, passes through user's own status line)
                      ▼                                  │
               ┌─────────────────────────────────────────▼──┐
               │ islet-daemon  (GJS, standalone process)     │
               │  • D-Bus service io.github.jagosar.Islet    │
               │  • watches ~/.claude/projects (inotify)    │
               │  • usage aggregation, plan usage, sessions │
               │  • MPRIS, focus timer state, git/gh later  │
               │  • state in $XDG_STATE_HOME/islet/         │
               └───────────────┬────────────────────────────┘
                               │ D-Bus (properties + signals)
               ┌───────────────▼────────────────────────────┐
               │ GNOME Shell extension (UI only)            │
               │  • capsule next to the clock, primary mon. │
               │  • compact / live activity / expanded      │
               │  • spawns + stops the daemon               │
               └────────────────────────────────────────────┘
```

### 3.1 Language and runtime: TypeScript on GJS, end to end

- **One language, one runtime.** The extension must be GJS; writing the daemon and the bridges
  in GJS too means shared types and D-Bus definitions, and **zero runtime dependencies** for
  users: every GNOME system already has `gjs`. Python, Node or Rust would add a second runtime
  to install, package and review.
- **TypeScript**, compiled by `tsc` to readable ES modules (no bundler, no minifier, as EGO requires),
  typed against GObject introspection via the `@girs/*` packages.
- **Pure core.** `src/core` imports nothing from `gi://`. Parsers, aggregation, the island state
  machine and the settings merger are plain TypeScript, tested under Node with Vitest (fast,
  no Shell needed). Only thin adapters touch GLib/Gio/St.
- Node and npm are **build-time only**.

### 3.2 Why a separate daemon if both are GJS

- Parsing transcripts (the first scan can be hundreds of MB) is CPU work; on the Shell's main
  loop it would stutter the whole desktop.
- A bug in the daemon cannot take the session down; the extension shows "unavailable" and retries.
- **Lifecycle:** the extension starts the daemon with `Gio.Subprocess` in `enable()` and stops it
  in `disable()`. D-Bus name ownership guarantees a single instance. No systemd unit to install,
  nothing left behind on uninstall.
- **Verified in spike S2** (nested Shell): disable stops the daemon; enable starts a new one; a
  newer daemon takes the bus name (`ALLOW_REPLACEMENT | REPLACE`) and the old one exits; when the
  Shell leaves the bus every daemon exits. Known gap: a daemon the extension did not start (e.g.
  run by hand) survives `disable()` until the next `enable()` replaces it or the Shell exits.

### 3.3 Storage

Daily aggregates per provider and model, plus a cursor (file, inode, offset) per transcript, in
JSON under `$XDG_STATE_HOME/islet/` (written atomically: temp file + rename). 26 weeks of daily
totals are a few KB, so SQLite (no binding guaranteed in GJS) is not needed. Settings live in
GSettings (`org.gnome.shell.extensions.islet`), edited in a libadwaita preferences window.

## 4. Placement

- **Next to the clock**, in the top bar's center box, **primary monitor only** (where GNOME puts
  the panel). The clock is never hidden or replaced. Added through
  `Main.panel.addToStatusArea(…, 'center')` rather than poking private boxes.
- **The clock must not jump** when the capsule grows. The center box re-centers its children,
  so a growing capsule would push the clock sideways. Fix: an invisible **mirror spacer** on the
  clock's other side that animates to the same width. *(spike)*
- Living in the top bar removes whole subsystems of the original: drag and anchors, per-app
  auto-hide and the notch, fullscreen avoidance (GNOME hides the panel itself), multi-monitor
  DPI placement and the outside-click logic.

### 4.1 States

| State | Where | Trigger |
|---|---|---|
| **Compact** | In the panel, panel height | Default: the featured module (`Claude 1.1M · 72%`, song, `Focus 18:42`) |
| **Live activity** | In the panel, wider, then shrinks back | Agent needs permission / waiting / done; song change; focus end; plan crosses 75 / 90 % |
| **Expanded** | Popover below the panel | Click, or keyboard shortcut (default `Super+I`, configurable) |

Urgent signals win over the featured module: agent waiting for permission > focus ending > plan
above 90 % > the rest. All animations respect GNOME's "reduce animation" setting.

## 5. Modules

Every module has the four honest states of the original: **working**, **empty** (with what to
do), **unavailable** (prerequisite missing) and **error** (with retry). A disabled module does no
work: no watchers, no timers, no processes.

### v1

**Claude Code — usage**
- Source: `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`), read incrementally with
  inotify and byte cursors. Only metadata fields are read: `message.usage`, `message.model`,
  `message.id`, `timestamp`, `sessionId`, `cwd`, `entrypoint`, `isSidechain`. Message content
  is never parsed into the model.
- **De-duplicate by `message.id`.** Claude Code writes one line per content block, each repeating
  the same usage. Measured on real data: 68 usage records, 32 unique messages; summing naively
  overcounts by ~2.1×.
- Metrics as in the original: input, cache write, output, cache read; **fresh** = input + cache
  write + output; **processed** = fresh + cache read. Subagent (`isSidechain`) usage is included.
- Unknown usage fields (e.g. `iterations`) are ignored and logged once, never guessed.
- No API-equivalent cost in v1: on a subscription it is misleading and the price table is a
  maintenance burden.

**Claude Code — plan usage (5 h and 7 d windows)**
- Source: the `rate_limits` object Claude Code passes to its **status line** command
  (`five_hour` / `seven_day`, `used_percentage`, `resets_at`). Present for Pro/Max only, after
  the first response of a session; either window may be absent.
- `islet-statusline` forwards those numbers to the daemon and then runs the user's previous
  status line command (if any) and prints its output unchanged, so nothing visible changes.
- **Spike S4:** the desktop app does **not** run the status line; the terminal does; VS Code is
  still to be checked. So plan usage only refreshes while a terminal session is active. The UI
  must say "plan usage comes from terminal sessions" and show when the figure was last measured,
  and the compact capsule should not lead with a stale percentage.
- Never computed from token counts. Never read from the OAuth token or undocumented endpoints.

**Claude Code — live agent activity** (the most useful feature)
- Source: **hooks**, which Claude Code fires "wherever it runs", including IDE extensions and the
  desktop app. Events: `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`,
  `agent_completed`), `Stop`, `SessionStart`, `SessionEnd`.
- **Improvement over the original:** a list of *current* sessions (project folder, state, time
  waiting), not only the last event.
- `islet-hook` reads stdin, keeps a whitelist of fields (`session_id`, `cwd`, `hook_event_name`,
  notification type, `transcript_path`), calls the daemon over D-Bus with a 200 ms timeout,
  prints nothing and **always exits 0**, so it can never block or alter Claude Code. This
  matters: a `Stop` hook that exits 2 keeps Claude from stopping.
- **Verified in spike S3** with real payloads against the nested Shell: `Notification` and
  `Stop` arrive as `AgentEvent`; `last_assistant_message` and `message` never leave the hook;
  invalid input is dropped; with Islet down the hook still exits 0, silently, in ~60 ms.
- **Real entry points (2026-10-16):**

  | Entry point | Hooks (`Notification`, `Stop`) | Status line (plan usage) |
  |---|---|---|
  | Desktop app (`claude-desktop`) | ✓ both, after the stdin fix below | ✗ never runs |
  | Terminal CLI (`cli`) | not yet verified (login had expired) | ✓ runs |
  | VS Code (`claude-vscode`) | not yet verified | not yet verified |

  **Bug found:** the desktop app passes hook input through a socket; opening `/dev/stdin` on a
  socket fails with ENXIO, so every desktop event was dropped. The bridge reads fd 0 instead.
  **Consequence for plan usage:** the status line is not a reliable source for people who work
  in the desktop app; see §5.

**Media**: MPRIS over D-Bus (any player: Spotify, browsers, Rhythmbox…). Title, artist, art,
play/pause, previous/next, seek where supported. The playing player wins; a closed player clears.

**Focus**: 25 / 50 / 90 min and custom; pause, resume, stop; countdown in the capsule; survives a
restart; daily history (today and 7 days).

### Later

| Version | Module | Notes |
|---|---|---|
| v1.1 | **Git** | Repository of the latest Claude Code session (from hook `cwd`); branch, changes, ahead/behind. Never scans the disk |
| v1.1 | **GitHub** | Via `gh` (read-only `gh api`); notifications, my PRs, review requests, CI of the active repo. App never touches tokens |
| v1.2 | **System alerts** | No duplicate of Vitals or the panel: only alerts (CPU > 85 % for 15 s, GPU/CPU temperature thresholds) from `/proc`, `/sys/class/hwmon`, NVML |
| v1.2 | **Next meeting** | GNOME's clock menu already shows calendar events. Only a live activity in the hour before an event, read from `org.gnome.Shell.CalendarServer` (no iCal links, no secrets) |
| later | Codex / other agents | Provider interface stays open; contributions welcome |

### Not ported

| Original feature | Reason |
|---|---|
| Camera / microphone indicators | GNOME shows them natively |
| Auto-hide, notch, drag, anchors, fullscreen policy | Unnecessary inside the top bar |
| Home Cloud (drop to network share) | Relies on a global mouse hook; not possible on Wayland; out of scope |
| Awake (lid action, Task Scheduler) | Windows-specific; GNOME has idle inhibitors and existing extensions (Caffeine) |
| Tasks | Out of the product's focus |
| Tray icon | The capsule is the entry point |

## 6. Claude Code integration (writing `settings.json`)

- **Opt-in only**, from a "Connect Claude Code" button in Preferences. Never automatic.
- Before writing, the window shows the exact JSON that will be added. The original file is backed
  up next to it (`settings.json.islet-backup-YYYYMMDD-HHMMSS`), the merge preserves every other
  key, and the write is atomic.
- An existing `statusLine` is kept and chained (see §5). Existing hooks are kept; ours are added
  alongside and tagged so **Disconnect** removes exactly them.
- Honors `$CLAUDE_CONFIG_DIR`. If the file is not valid JSON, we refuse to touch it and say why.

## 7. Security and privacy

- Local-first: no telemetry, no accounts, no network except `gh` (later, opt-in by module).
- Subprocesses only via `Gio.Subprocess` with argv arrays, never shell strings; all async.
- The D-Bus service is on the session bus (same trust boundary as the user); inputs are
  size-limited and validated.
- Logs never contain prompts, paths outside `~/.claude`, or message content.

## 8. Quality

- **Tests:** Vitest for `src/core` with sanitized JSONL fixtures (including duplicated message
  ids, truncated last line, rotated files, unknown fields); a daemon integration test under
  `gjs` with a temporary `HOME`; manual UI checks in a nested Shell (`gnome-shell --devkit`).
- **CI (GitHub Actions):** `tsc --noEmit`, ESLint (GNOME config), Vitest, `gnome-extensions pack`
  artifact. Actions pinned by SHA, `contents: read`.
- **Budgets (measured, not promised):** daemon idle CPU ≈ 0 %, RSS target < 50 MB; extension
  adds no timers while nothing changes (1 Hz only while a countdown is visible).
- **Compatibility:** GNOME 50 first (Ubuntu 26.04 LTS). GNOME 51 added to `shell-version` only
  after it has been tested.

## 9. Repository layout

```
islet/
├── src/             compiles 1:1 into dist/, which is the extension directory
│   ├── extension.ts, prefs.ts, metadata.json, stylesheet.css
│   ├── core/        pure TypeScript: parsers, aggregation, state machine, settings merge
│   ├── ui/          Shell widgets (capsule, expanded view)
│   ├── daemon/      GJS: watchers, providers, D-Bus service
│   └── bridge/      islet-hook, islet-statusline
├── scripts/         nested.sh: isolated nested Shell for manual testing
├── schemas/         org.gnome.shell.extensions.islet.gschema.xml
├── data/            D-Bus interface XML
├── po/              translations
├── tests/           unit tests and fixtures
└── docs/
```

## 10. Spike plan (before real code)

| # | Question | Done when |
|---|---|---|
| S1 | Can the capsule sit next to the clock and grow without moving it? | Animated width change in a nested Shell; clock does not move; `disable()` leaves nothing behind (Looking Glass) |
| S2 | Daemon lifecycle | Extension spawns it, receives a D-Bus signal, kills it on disable; restarting the Shell does not leave orphans |
| S3 | Hooks from every entry point | A `Notification` from the terminal CLI, the desktop app **and VS Code** reaches the capsule |
| S4 | Does the status line run outside the terminal? | Probe script logs whether VS Code / desktop app call it; decides the plan-usage UX |
| S5 | Token accounting | Totals for a day match Claude Code's own `/usage` view within rounding |

## 11. Open risks

1. GNOME breaks extension APIs between major versions: keep Shell-touching code small and in one place.
2. Transcript format is not a public API: defensive parsing, fixture tests, unknown-field logging.
3. EGO review: AI-assisted code is allowed only if the author can explain it; no prompt-like
   comments, no dead code, consistent style.
4. Plan usage may only be available from terminal sessions (S4).
