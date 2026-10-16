// SPDX-License-Identifier: GPL-2.0-or-later
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {REPO} from '../integration/harness.js';

const UUID = 'islet@jagosar.github.io';

/**
 * install.sh and uninstall.sh run against stand-ins for `gnome-extensions`, `gsettings` and
 * `gnome-shell` (a file-backed fake of the enabled-extensions setting), in a temporary HOME.
 * The real gjs and the real extension zip are used.
 */
describe('install.sh and uninstall.sh', () => {
    let root: string;
    let release: string;

    const write = (path: string, text: string) => {
        writeFileSync(path, text);
        chmodSync(path, 0o755);
    };

    beforeAll(() => {
        execFileSync('npm', ['run', '--silent', 'release'], {cwd: REPO});
        root = mkdtempSync(join(tmpdir(), 'islet-install-'));
        release = join(root, 'islet-0.1.0');
        execFileSync('tar', ['-xzf', join(REPO, `islet-${(JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {version: string}).version}.tar.gz`), '-C', root]);
        release = join(root, execFileSync('ls', [root], {encoding: 'utf8'}).split('\n').find(name => name.startsWith('islet-'))!);

        const bin = join(root, 'bin');
        mkdirSync(bin);
        write(join(bin, 'gnome-shell'), '#!/bin/sh\necho "GNOME Shell ${FAKE_SHELL_VERSION:-50.1}"\n');
        write(join(bin, 'gnome-extensions'), `#!/bin/sh
dir="$XDG_DATA_HOME/gnome-shell/extensions"
case "$1" in
    install) [ "$2" = "--force" ] && shift; mkdir -p "$dir/${UUID}" && unzip -qo "$2" -d "$dir/${UUID}" ;;
    enable) [ -n "$FAKE_ENABLE_FAILS" ] && exit 1; exit 0 ;;
    disable) exit 0 ;;
    uninstall) rm -rf "$dir/${UUID}" ;;
esac
`);
        write(join(bin, 'gsettings'), `#!/bin/sh
store="$HOME/gsettings"
mkdir -p "$store"
key="$(echo "$2 $3" | tr ' /' '__')"
case "$1" in
    get) cat "$store/$key" 2>/dev/null || { [ "$3" = enabled-extensions ] && echo "@as []" || echo false; } ;;
    set) printf '%s\\n' "$4" > "$store/$key" ;;
esac
`);
    });

    afterAll(() => {
        rmSync(root, {recursive: true, force: true});
    });

    function env(name: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
        const home = join(root, name);
        mkdirSync(join(home, 'claude'), {recursive: true});
        return {
            PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, HOME: home, XDG_DATA_HOME: join(home, 'data'),
            XDG_STATE_HOME: join(home, 'state'), CLAUDE_CONFIG_DIR: join(home, 'claude'), LANG: 'C.UTF-8', ...extra,
        };
    }

    const sh = (script: string, args: string[], environment: NodeJS.ProcessEnv, input?: string) =>
        spawnSync(join(release, script), args, {env: environment, encoding: 'utf8', cwd: release, input});
    const enabled = (environment: NodeJS.ProcessEnv) => readFileSync(join(environment.HOME!, 'gsettings/org.gnome.shell_enabled-extensions'), 'utf8').trim();
    const seed = (environment: NodeJS.ProcessEnv, value: string) => {
        mkdirSync(join(environment.HOME!, 'gsettings'), {recursive: true});
        writeFileSync(join(environment.HOME!, 'gsettings/org.gnome.shell_enabled-extensions'), `${value}\n`);
    };

    it('installs for the user, enables the extension and says what to do next', () => {
        const e = env('fresh');
        const result = sh('install.sh', ['--no'], e);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(join(e.XDG_DATA_HOME!, 'gnome-shell/extensions', UUID, 'extension.js'))).toBe(true);
        expect(result.stdout).toMatch(/Log out and back in/);
        expect(result.stdout).toMatch(/Claude Code not connected/);
        expect(existsSync(join(e.CLAUDE_CONFIG_DIR!, 'settings.json'))).toBe(false);
    });

    it.each([
        ['an empty list', '@as []', `['${UUID}']`],
        ['one other extension', "['a@b']", `['a@b', '${UUID}']`],
        ['several', "['a@b', 'c@d']", `['a@b', 'c@d', '${UUID}']`],
    ])('adds itself to the enabled list when GNOME does not know it yet: %s', (_name, before, after) => {
        const e = env(`enable-${_name.replace(/\W/g, '')}`, {FAKE_ENABLE_FAILS: '1'});
        seed(e, before);
        expect(sh('install.sh', ['--no'], e).status).toBe(0);
        expect(enabled(e)).toBe(after);
    });

    it('does not add itself twice', () => {
        const e = env('twice', {FAKE_ENABLE_FAILS: '1'});
        seed(e, `['${UUID}']`);
        sh('install.sh', ['--no'], e);
        expect(enabled(e)).toBe(`['${UUID}']`);
    });

    it('warns on another GNOME Shell version, but still installs', () => {
        const e = env('other-shell', {FAKE_SHELL_VERSION: '49.2'});
        const result = sh('install.sh', ['--no'], e);
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/built and tested for GNOME Shell 50; this is GNOME Shell 49/);
    });

    it('connects Claude Code with --yes, asks with a terminal, and respects the answer', () => {
        const yes = env('yes');
        writeFileSync(join(yes.CLAUDE_CONFIG_DIR!, 'settings.json'), '{"theme":"dark"}\n');
        expect(sh('install.sh', ['--yes'], yes).status).toBe(0);
        expect(readFileSync(join(yes.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).toContain('islet@jagosar.github.io/bridge/');

        // Without a terminal (stdin is a pipe) the installer must not hang on its question.
        const piped = env('piped');
        const result = sh('install.sh', [], piped, 'y\n');
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/Claude Code not connected/);
    });

    it('fails clearly on an unknown option', () => {
        const result = sh('install.sh', ['--bogus'], env('bogus'));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/unknown option/);
    });

    it('uninstalls completely: extension, enabled entry, state, and Claude settings byte for byte', () => {
        const e = env('uninstall', {FAKE_ENABLE_FAILS: '1'});
        const original = '{\n  "theme": "dark"\n}\n';
        writeFileSync(join(e.CLAUDE_CONFIG_DIR!, 'settings.json'), original);
        seed(e, "['a@b']");
        expect(sh('install.sh', ['--yes'], e).status).toBe(0);
        mkdirSync(join(e.XDG_STATE_HOME!, 'islet'), {recursive: true});
        writeFileSync(join(e.XDG_STATE_HOME!, 'islet/focus.json'), '{}');
        expect(enabled(e)).toBe(`['a@b', '${UUID}']`);

        const result = sh('uninstall.sh', [], e);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(join(e.XDG_DATA_HOME!, 'gnome-shell/extensions', UUID))).toBe(false);
        expect(existsSync(join(e.XDG_STATE_HOME!, 'islet'))).toBe(false);
        expect(enabled(e)).toBe("['a@b']");
        expect(readFileSync(join(e.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).toBe(original);
    });

    it('uninstalls cleanly when it was never installed', () => {
        const result = sh('uninstall.sh', [], env('never'));
        expect(result.status).toBe(0);
        expect(result.stdout).toMatch(/removed/);
    });
});
