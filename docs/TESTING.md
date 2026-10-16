# Testing

Islet runs inside GNOME Shell, where a bug can end the user's session, so the strategy is to keep
as much logic as possible out of the Shell and to test each layer at the cheapest level that can
catch its failures.

| Layer | What it covers | Where | Runs |
|---|---|---|---|
| **Static** | Types, strict type-aware lint, ShellCheck | `npm run typecheck`, `npm run lint` | CI, every push |
| **Unit** | The pure core: parsing, token accounting, sessions, focus timer, settings merge, protocol. Gated at 95 % lines, 90 % branches | `tests/core`, `npm run test:coverage` | CI, Node 22 and 24 |
| **GJS smoke** | The built core under GJS (`Intl`, `TextDecoder` and module loading differ from Node) | `tests/gjs`, `npm run test:gjs` | CI |
| **Integration** | The real daemon, bridges and `claudeConnection` tool as gjs processes on a **private D-Bus session** with synthetic transcripts and a temporary Claude config | `tests/integration`, `npm run test:integration` | CI |
| **Package** | The extension zip (contents, imports, metadata, schema, licence headers) and `install.sh` / `uninstall.sh` against stand-ins for `gnome-extensions` and `gsettings` | `tests/package` | CI |
| **End to end** | The extension in a nested GNOME Shell: capsule text, live activities, centring of the clock, daemon crash and restart; optionally the shortcut and tabs | `tests/e2e`, `npm run e2e` | Locally (needs a GNOME desktop) |

`npm run test:all` runs everything except the end-to-end suite, as CI does.

## Conventions

- **Every bug gets a regression test** that fails without the fix, at the lowest layer that can
  reproduce it. The unit layer is preferred; the daemon's I/O needs the integration layer.
- **Hermetic.** Integration tests create their own D-Bus daemon, Claude config, state and runtime
  directories under a temporary folder and never touch `~`, the real session bus or the real
  `~/.claude`. The development debug service (`src/dev`) is not in the package.
- **No fixed sleeps for "it should have happened by now".** Use `waitFor` (polls with a clear
  timeout message). A short sleep is only acceptable to prove that something did *not* happen.
- **Tests state behaviour, not implementation.** They read D-Bus properties and files, not private
  fields.
- **Deterministic.** Time zone is fixed (`TZ=UTC`), animations are off in the end-to-end suite,
  and nothing depends on the network.

## Gaps, on purpose

- **The Shell UI is not automated in CI.** GNOME Shell 50 is not available on GitHub-hosted
  runners, and a nested Shell only processes input while its window is being painted (an
  occluded window's frame clock is throttled). The end-to-end suite is therefore run locally;
  `E2E_KEYBOARD=1` adds the keyboard checks and needs the window to stay visible.
- **Lock-screen behaviour** is covered by simulating it at the daemon level (the daemon is stopped
  while hooks fire, then started again: `tests/integration/lock.test.ts`); a real lock cycle is
  not automated.
- **Memory budget** (`tests/integration/performance.test.ts`): 120 MB of transcripts, daemon under
  90 MB. The test was checked by mutation: the variant that broke the budget once (raw bytes per
  line, 136 MB) fails it.
