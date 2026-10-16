## What and why

<!-- What changes, and the problem it solves. Link the issue: "Closes #123". -->

## How it was tested

- [ ] Unit tests for new or changed logic in `src/core` (coverage gate stays green)
- [ ] A regression test that fails without the fix, for bug fixes
- [ ] Integration tests (`npm run test:integration`) for daemon, bridge, tool or installer changes
- [ ] `npm run e2e` in a nested Shell for changes to what the capsule shows
- [ ] Nothing here touches `~/.claude` or the real GNOME session except through the opt-in flows

## Risk

<!-- Anything inside GNOME Shell can end the session: say what is cleaned up in disable(), and what happens on failure. -->
