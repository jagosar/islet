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

## Installing a build

> Islet is a prototype. An extension runs inside GNOME Shell, and a serious bug can end your
> session. Try it in a nested Shell first (`npm run nested:zip`, below).

Download `islet-extension` from the latest successful
[CI run](https://github.com/jagosar/islet/actions/workflows/ci.yml) (a zip inside a zip), or
build it yourself with `npm run pack`. Then:

```bash
gnome-extensions install --force islet@jagosar.github.io.zip
```

Log out and back in (GNOME Shell on Wayland only picks up new extensions at login), then:

```bash
gnome-extensions enable islet@jagosar.github.io
```

To remove it: `gnome-extensions uninstall islet@jagosar.github.io`.

## Development

```bash
npm install
npm run build          # TypeScript -> dist/
npm test               # unit tests for the pure core (Node)
npm run test:gjs       # smoke test of the built core under GJS
npm run lint
npm run pack           # build islet@jagosar.github.io.zip
npm run nested         # run dist/ in an isolated nested GNOME Shell
npm run nested:zip     # pack, install the zip and run it in the nested Shell
npm run install-local  # pack and install for your user (does not enable it)
```

The nested Shell never touches your real session: it gets its own configuration, data, cache
and D-Bus session under `$XDG_RUNTIME_DIR/islet-devkit/`.
