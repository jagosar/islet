# Submitting to extensions.gnome.org

The submission is done by the maintainer, with their own account: upload the zip at
<https://extensions.gnome.org/upload/>. Reviewers read the code, so this page records what was
checked against the [review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and what a reviewer is likely to ask.

## Checked

| Guideline | Islet |
|---|---|
| Readable, not minified or obfuscated; TypeScript transpiled to well-formatted JavaScript | `tsc` output, no bundler, no minifier |
| `metadata.json`: `uuid` `extension-id@namespace`, not `gnome.org`; `url` a repository; no `version` (EGO sets it) | `islet@jagosar.github.io`, GitHub URL, only `version-name` |
| `shell-version`: stable releases only, none in the future | `["50"]` |
| GSettings schema ID based on `org.gnome.shell.extensions`, XML in the zip | `org.gnome.shell.extensions.islet`, XML and compiled schema shipped |
| `prefs.js` imports no `Clutter`, `Meta`, `St` or `Shell`; the Shell process imports no `Gtk`, `Gdk` or `Adw` | Checked by `tests/package/zip.test.ts` |
| Everything done in `enable()` is undone in `disable()`: objects destroyed, signals disconnected, main-loop sources removed, subprocess stopped | Reviewed; the rollback of a failed `enable()` is tested end to end |
| Spawned processes are spawned carefully and exit cleanly | One `gjs` daemon through `Gio.Subprocess`, stopped by `disable()`, restarted with backoff, exits if the Shell leaves the bus |
| No excessive logging | Warnings and errors only |
| No unnecessary files or code | The package has no `dev/` folder and no test hooks: regions marked `DEV-ONLY` are stripped at packaging time (`scripts/strip-dev.mjs`), checked by a package test |
| OSI-approved license | GPL-2.0-or-later, SPDX header in every file |
| `unlock-dialog` | Not used, on purpose (see ARCHITECTURE §3.2.1) |
| No `sudo` or `pkexec`; no binaries; no network | None |

## What a reviewer may ask, and the answers

- **Why a separate daemon?** Parsing transcripts is CPU work that must not run in the compositor
  (it would stutter the desktop), and a bug there must not take the session down. It is a GJS
  script inside the package, started and stopped by the extension. See ARCHITECTURE §3.
- **Why does it edit `~/.claude/settings.json`?** Only when the user presses *Connect…* in
  Preferences, after seeing the exact change. It adds hooks and a status line for live agent
  alerts, keeps a private backup, touches only its own entries and can undo them byte for byte.
  Without connecting, the extension still shows token usage and works as is.
- **What does it read?** Token counts from `~/.claude/projects` transcripts, never message
  content into its model. Nothing leaves the computer.
- **AI-assisted code.** The project was developed with an AI coding assistant, reviewed and tested
  by the maintainer; there are no prompt-like comments and no unused code, and the logic is
  covered by unit, integration and end-to-end tests (`docs/TESTING.md`).

## Suggested listing text

> **Islet** puts a small capsule next to the clock: today's Claude Code token usage and plan limits,
> live alerts when an agent needs your permission or has finished, what is playing, and a focus
> timer. Everything stays on your computer. Needs `gjs` (installed with GNOME). Optional: connect
> Claude Code from Preferences for live alerts and plan usage.

Add the screenshots from `docs/assets/` in the upload form.

## Steps

1. Build the package: `npm run pack` (or take `islet@jagosar.github.io.zip` from the latest
   release, which is the same file).
2. Sign in at <https://extensions.gnome.org> and upload the zip. Pick the description, the
   screenshots, and the license.
3. Answer reviewer comments in the review page. Each fix goes through a pull request and a new
   release, then upload the new zip as the next version.
