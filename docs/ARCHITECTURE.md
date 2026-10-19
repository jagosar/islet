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

### 3.2.1 The lock screen

GNOME Shell switches extensions off in session modes they do not declare, and Islet declares
only `user`, so **the daemon stops when the screen locks and starts again at unlock** (it is not
shown on the lock screen on purpose: project names are private). Claude Code keeps working
meanwhile, so nothing may be lost:

- **The bridges spool.** When the D-Bus call fails, `islet-hook` and `islet-statusline` leave the
  event (or the latest plan usage) as a small private file in `$XDG_RUNTIME_DIR/islet/spool`,
  written atomically, at most 500 files. The daemon replays the spool when it starts, in order
  and with the events' own times, and also when a bridge leaves something while it runs. Replays
  update state but raise no live activity: they are not news. Stale (over 6 h), damaged and
  replayed files are deleted; files that are not ours are left alone.
- **The sessions are saved** to `$XDG_STATE_HOME/islet/sessions.json` on every change and
  restored (minus the expired) at start, so a restart does not forget them.
- Declaring `unlock-dialog` was rejected: it would run the extension on the lock screen, where a
  bug locks the user out, and EGO requires a justification for it.

### 3.3 Storage

Daily aggregates per provider and model, plus a cursor (file, inode, offset) per transcript, in
JSON under `$XDG_STATE_HOME/islet/` (written atomically: temp file + rename). 26 weeks of daily
totals are a few KB, so SQLite (no binding guaranteed in GJS) is not needed. Settings live in
GSettings (`org.gnome.shell.extensions.islet`), edited in a libadwaita preferences window.

### 3.4 D-Bus API v1 (`io.github.jagosar.Islet1`)

| Member | Kind | Content |
|---|---|---|
| `Usage` | property `s` | `UsageSnapshot`: today's tokens per model, fresh tokens per day |
| `PlanUsage` | property `s` | `PlanUsage`: 5 h / 7 d windows and `measuredAt`, or `null` |
| `Sessions` | property `s` | `AgentSession[]`: current Claude Code sessions |
| `Insights` | property `s` | `Insights`: what is using the plan limits (24 h and 7 days) and the current session, or `null` |
| `ReportAgentEvent(a{ss})` | method | from the hook bridge |
| `ReportPlanUsage(a{sd})` | method | from the status line bridge |
| `AgentEvent(a{ss})` | signal | re-emitted agent events, for live activities |

- **Properties are versioned JSON documents** (`{"version": 1, …}`), defined and validated in
  `src/core/protocol.ts`. Nested D-Bus structures are awkward in GJS and cannot be tested without
  a bus; JSON validated by the pure core is identical on both sides and unit tested. A document
  that does not validate (or has another version) reads as "no data", never as an error.
- Methods take flat dictionaries so the bridges stay trivial; every argument is validated and
  size-limited (the session bus is shared by all of the user's processes).
- Changes go out as `PropertiesChanged`. The extension mirrors them through a `GDBusProxy`, which
  also follows the bus name to a new owner after a daemon restart.
- Plan usage is persisted in `$XDG_STATE_HOME/islet/plan-usage.json`, so a restarted daemon
  still knows it.
- **Daemon restarts:** when the daemon exits and no other daemon owns the name, the extension
  restarts it after 1 s, doubling up to 60 s; a daemon that ran for a minute resets the delay.
  The capsule greys out while the daemon is unavailable.
- **Limits.** Anything on the session bus can call the daemon, so `ReportAgentEvent` is rate
  limited (50 per second, bursts of 100) and `ReportPlanUsage` too (20 per second, bursts of 40);
  the excess is dropped with one warning per 5 seconds. At most 200 sessions are tracked (the one
  quiet the longest is forgotten first), and the aggregator forgets sessions and response ids
  older than the 26 weeks shown, plus a week, once a day.
- **Plan usage is not re-announced for nothing.** Claude Code runs the status line several times
  per second during a reply with the same figures. A change in the figures is published and saved
  at once; the same figures only refresh "measured at" every 30 seconds.
- Media and focus methods are added with their modules (#10, #11).

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
- **Verified in spike S5** against the `cost-state.modelUsage` Claude Code writes when a
  session ends:
  - De-duplicated by `message.id` across all transcript files (a resumed session copies earlier
    responses), the transcript totals match **exactly** for a session with only conversation
    turns. A naive sum overcounts by up to 1.9×.
  - They **undercount** sessions with auxiliary calls that are never written to the transcript:
    the auto-mode permission classifier, the generated session title and the "away" summary.
    Measured on one terminal session: fresh −1.3 %, cache reads −67 % (the classifier re-reads
    the context), plus a model that never appears in the transcript.
  - `output_tokens` already includes thinking tokens, so they are not added again. Responses
    with model `<synthetic>` are local messages and are skipped. Days are local days (`Intl`,
    works in GJS).
- **Decision:** live totals come from transcripts. When a session's `cost-state` appears, its
  totals replace the transcript totals for that session, with the difference booked on the
  session's last day. The UI never calls a running session's figures exact, and leads with
  fresh tokens, which the auxiliary calls barely affect. `scripts/usage-report.mjs` repeats the
  comparison on any machine.
- ~~No API-equivalent cost in v1~~ **Revised in 0.2.0:** the Usage tab shows the current
  session's cost, like Claude Code's own `/usage` and the desktop app do. An ended session shows
  Claude Code's own figure from its `cost-state` (exact). A running one is estimated at public list
  prices by model family (Opus $5, Sonnet $3, Haiku $1 per million input tokens; cache write
  1.25×, cache read 0.1×, output 5×) and is marked "≈". Calibrating prices from `cost-state` was
  tried and rejected: a least-squares fit over 55 sessions gave a negative input price (long-
  context tiers and cache lifetimes make it unstable).

**Claude Code — plan usage (5 h and 7 d windows)**

Anthropic's servers compute plan usage; Claude Code and the desktop app fetch it with the
user's login. Islet never does that (no token, no network). It merges what already reaches this
computer, always keeping the most recent reading (`src/core/planSources.ts`):

| Source | Windows | Reset time | When |
|---|---|---|---|
| Status line bridge (terminal sessions) | both | ✓ | several times per reply |
| The desktop app's `~/.config/Claude/plan-usage-history.json` | both | ✗ | every ~15 min while the app runs |
| "You've hit your session limit · resets 4:20pm (Europe/Berlin)" in transcripts | the one it names, at 100 % | ✓ | when a limit is hit, in every entry point |

- A reading without a reset time keeps the previous one while it is the same window (not reset
  yet, percentage not lower). The capsule shows a figure for 30 minutes after it was measured,
  longer than the desktop app's sampling interval.
- The desktop history is the desktop app's own file. Islet only reads it, watches its folder
  (the app replaces the file by renaming), parses it defensively (unknown shapes read as no data)
  and opens nothing else there.

Status line details:
- Source: the `rate_limits` object Claude Code passes to its **status line** command
  (`five_hour` / `seven_day`, `used_percentage`, `resets_at`). Present for Pro/Max only, after
  the first response of a session; either window may be absent.
- `islet-statusline` forwards those numbers to the daemon and then runs the user's previous
  status line command (if any) and prints its output unchanged, so nothing visible changes.
- **Spike S4:** the desktop app does **not** run the status line; the terminal does, several
  times per reply, and `rate_limits.five_hour` / `seven_day` appear from the first reply on (seen
  on a Max/Pro login: 32 % and 4 %); VS Code is still to be checked. So plan usage only refreshes while a terminal session is active. The UI
  must say "plan usage comes from terminal sessions" and show when the figure was last measured,
  and the compact capsule should not lead with a stale percentage.
- Never computed from token counts. Never read from the OAuth token or undocumented endpoints.

**Claude Code — what is using your limits** (the Usage tab, since 0.2.0)
- Claude Code records, on every response in its transcripts, what its own `/usage` breakdown
  attributes it to: `attributionMcpServer`, `attributionSkill`, `attributionAgent`,
  `attributionPlugin`. Islet reads these names (configuration names, not content) and the token
  counts, keeps a week of responses, and computes for the last 24 hours and 7 days
  (`src/core/usage/insights.ts`):
  - the share of usage per MCP server, skill, subagent and plugin (rows of 1 % or more, top six);
  - behaviours that reach 10 %: requests with more than 150k tokens of context, from sessions
    started more than 8 hours earlier, made while 4 or more sessions were active (a request in the
    previous 10 minutes), "always-on context" (the session's first context, re-read from cache on
    every request: system prompt, tools, CLAUDE.md), and cache misses (a later request writing
    most of a context over 20k again).
- Usage is weighted by estimated cost, so a cache read counts a tenth of an input token. As in
  `/usage`, figures are approximate, overlap, and cover this computer only.
- Checked against the desktop app's panel on the same data: 81/51/21/14 % against 79/63/19/12 %
  for the four behaviours, and the same attribution rows within a point (different 24-hour
  windows).
- The current session (the one with the latest main-thread response) shows cost, active time
  (gaps of up to 5 minutes), API time and changed lines (from `cost-state`, once written), the
  model mix, cache hits, and tokens and cost per model.

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
  | Terminal CLI (`cli`) | ✓ `SessionStart`, `Notification`, `Stop` | ✓ runs; `rate_limits` arrive after the first reply |
  | VS Code (`claude-vscode`) | not yet verified | not yet verified |

  **Bug found:** the desktop app passes hook input through a socket; opening `/dev/stdin` on a
  socket fails with ENXIO, so every desktop event was dropped. The bridge reads fd 0 instead.
  **Consequence for plan usage:** the status line is not a reliable source for people who work
  in the desktop app; see §5.

**Media**: any MPRIS player (Spotify, browsers, Rhythmbox…). Title, artist, local artwork,
play/pause, previous/next. The playing player wins; a closed player clears. A new song raises a
live activity. *Implemented in the extension, not the daemon:* it is event-driven D-Bus work with
no CPU cost, and the Shell's own MPRIS client cannot be torn down in `disable()`, so Islet has a
small one that can. No timeline or seeking in v1 (it needs position polling).

**Focus**: 25 / 50 / 90 min presets; pause, resume, stop; countdown in the capsule (one tick
per second only while running); survives a restart (`$XDG_STATE_HOME/islet/focus.json`, written
asynchronously) and completes a session that ended while the Shell was not running; history for
today and the last 7 days. Stopping early counts the minutes but not a session.

**Compact precedence**: Claude sessions that need you, a focus session, Claude usage, what is
playing, then plain "Claude".

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

- **Opt-in only**, from **Connect…** in Preferences, which first shows the exact JSON it will add.
  The uninstaller disconnects through `tools/claudeConnection.js` (`status|connect|disconnect`).
- Islet adds hooks for `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `Stop` and
  `Notification`, and a status line. Its entries are recognised by the bridge path in their
  command; every other key and hook is kept.
- An existing status line is chained: Islet's command passes the previous one (base64) to the
  bridge, which runs it with the same input and prints its output unchanged.
- **Safe if Islet disappears:** the commands check that the bridge exists. Without it, hooks do
  nothing and exit 0, and the status line runs the user's previous command directly.
- The original file is saved as `settings.json.islet-backup`. **Disconnect** restores those
  exact bytes when nothing else changed meanwhile, otherwise removes only Islet's entries (and
  restores the previous status line). A file Islet created is deleted again.
- Writes are atomic (temporary file and rename) and keep the file's permissions. If the file is
  not valid JSON, Islet refuses to touch it and says why. Honors `$CLAUDE_CONFIG_DIR`.
- Claude Code reads hooks when a session starts, so running sessions need a restart.
- **Stale connections.** The commands carry the absolute path of the bridge, so a connection can
  go stale (the extension moved, an event was added in a newer version, or it was made by an
  older command format). Islet's entries are recognised by an `islet-bridge` tag in the command,
  not by a path, and compared with what the current version would write; Preferences then shows
  "Needs repair" with a **Repair…** button, and `tools/claudeConnection.js repair` does the same.
  Repair replaces only Islet's entries and keeps the backup and the chained status line.

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
  Measured (#16): 38 MB on a real history and 45 MB on 207 MB of transcripts, first scan about
  1 s, 0 ms CPU per 30 s idle. Reading line by line with `Gio.DataInputStream` was the fix:
  decoding large chunks with `TextDecoder` and `split()` kept up to 235 MB resident.
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
