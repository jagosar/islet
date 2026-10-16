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
