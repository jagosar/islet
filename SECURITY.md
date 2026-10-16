# Security policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately with GitHub's
[private vulnerability reporting](https://github.com/jagosar/islet/security/advisories/new). You
will get an answer within a few days, and a fix and an advisory once the problem is confirmed.

## What Islet touches, to help you judge a report

- It reads Claude Code's transcripts (`~/.claude/projects`) for token counts and never reads
  message content into its model.
- With your consent it edits `~/.claude/settings.json` (hooks and a status line). It keeps a
  private backup, changes only its own entries, and can undo them exactly.
- It runs a background process (the daemon) on your session D-Bus, and its hooks and status line
  bridge run inside Claude Code. Anything on your session bus can call the daemon, which is why
  its methods validate their input and are rate limited.
- It sends nothing over the network.

Out of scope: problems that need an attacker who already runs code as your user.

## Past advisories

- **0.1.0:** the backup `settings.json.islet-backup` was created readable by every user of the
  computer. Fixed in 0.1.1, which also tightens an existing backup.
