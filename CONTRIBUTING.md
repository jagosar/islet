# Contributing

Thanks for helping. Islet runs inside GNOME Shell, where a bug can end the user's session, so the
rules below are strict on purpose.

## Setup

```bash
npm install
npm run test:all      # what CI runs: typecheck, strict lint, unit with coverage gate, GJS, integration
npm run nested        # try the extension in an isolated nested GNOME Shell (needs mutter-dev-bin)
```

## Rules

- **A bug fix needs a regression test** that fails without the fix, at the lowest layer that can
  reproduce it, and you should confirm that by reverting the fix. See [docs/TESTING.md](docs/TESTING.md).
- **Keep logic out of the Shell.** Put it in `src/core` (pure TypeScript, unit tested) and keep
  the Shell code thin. Never block the Shell's main loop; undo everything in `disable()`.
- **Measure performance claims.** The daemon has a memory budget test; a change that reads
  transcripts differently must keep it green.
- **Privacy is a feature.** Do not read message content, and do not add network access.
- New files carry `// SPDX-License-Identifier: GPL-2.0-or-later` followed by a blank line.
- Maintainers keep their personal email out of the public history: `npm run hooks` enables a
  `commit-msg` hook that refuses commits not authored with a GitHub noreply address. (Contributors
  are not asked to do this.)

## Pull requests

`main` is protected: open a pull request, and the **CI passed** check must be green. Fill in the
template's test checklist. Branches are deleted after merging.

By contributing you agree that your work is released under the GPL-2.0-or-later license.
