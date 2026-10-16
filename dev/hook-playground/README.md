# Hook playground

A folder for testing Islet's Claude Code hooks without touching `~/.claude/settings.json`.
Its `.claude/settings.json` sends `Notification`, `Stop`, `SessionStart` and `SessionEnd`
events to the nested Shell started by `npm run nested`.

1. `npm run nested` from the repository root, and leave the window open.
2. Open **this folder** in Claude Code (terminal, desktop app or VS Code). Claude Code may ask
   you to approve the project's hooks.
3. Ask for something that needs a permission, for example "create a file named hello.txt".
   The capsule in the nested Shell should show "hook-playground needs your permission".
4. When Claude finishes a reply, it should show "hook-playground finished".

Nothing reaches your real session: the hooks only talk to the nested Shell's own D-Bus session.

## Status line probe (spike S4)

The folder also sets a status line command, `scripts/dev-statusline-probe.sh`, which records
each time Claude Code runs it, to learn which entry points run status lines at all. It does not
need the nested Shell. After using Claude Code here, read the log with:

```bash
cat "$XDG_RUNTIME_DIR/islet-devkit/statusline-probe.log"
```

Each line has the time, the entry point, the Claude Code version and the 5-hour and 7-day plan
usage, but no prompts, paths or messages.
