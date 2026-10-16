# Islet

A small dynamic island for the GNOME top bar: Claude Code usage and live agent alerts, what's
playing and a focus timer, right next to the clock. Local-first: no accounts, no telemetry.

> **Status: early prototype.** Nothing is ready to install yet. See
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the spike plan.

Inspired by [Developer Island](https://github.com/maximilian467/Developer-Island) for Windows.
Islet is an independent implementation for GNOME Shell on Wayland; it shares ideas, not code.

## Requirements

- GNOME Shell 50 on Wayland (developed on Ubuntu 26.04)
- For development: Node.js 20 or later and `mutter-dev-bin` (nested Shell for testing)

## Development

```bash
npm install
npm run build      # TypeScript -> dist/
npm test           # unit tests for the pure core
npm run lint
npm run nested     # build, then run the extension in an isolated nested GNOME Shell
```

`npm run nested` never touches your real session: the nested Shell gets its own configuration,
data and D-Bus session under `.devkit/`.
