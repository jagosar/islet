import {spawnSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {
    BRIDGE_MARKER, HOOK_EVENTS, SettingsError, chainedPreviousCommand, connectSettings, connectionStatus,
    disconnectSettings, fromBase64, hookCommand, plannedEntries, sameSettings, shellQuote, statusLineCommand, toBase64,
} from '../../src/core/claudeSettings.js';

const dir = `/home/me/.local/share/gnome-shell/extensions/${BRIDGE_MARKER}`;
const scripts = {hook: `${dir}hook.js`, statusLine: `${dir}statusline.js`};
const missing = {hook: '/nonexistent/islet@jagosar.github.io/bridge/hook.js', statusLine: '/nonexistent/islet@jagosar.github.io/bridge/statusline.js'};

function sh(command: string, input = '') {
    const result = spawnSync('sh', ['-c', command], {input, encoding: 'utf8'});
    return {status: result.status, stdout: result.stdout, stderr: result.stderr};
}

describe('base64 and quoting', () => {
    it.each(['', 'a', 'ab', 'abc', 'printf "%s" "$(jq -r .model.display_name)"', 'ñandú → 🚀'])('round-trips %j', text => {
        expect(fromBase64(toBase64(text))).toBe(text);
    });

    it('matches the system base64 tool', () => {
        expect(sh(`printf %s ${shellQuote('héllo "x" $y')} | base64 -w0`).stdout).toBe(toBase64('héllo "x" $y'));
    });

    it('quotes for sh, including single quotes', () => {
        expect(sh(`printf %s ${shellQuote(`it's $HOME "x"`)}`).stdout).toBe(`it's $HOME "x"`);
    });
});

describe('generated commands when Islet is not installed', () => {
    it('the hook does nothing and succeeds', () => {
        expect(sh(hookCommand(missing.hook), '{"hook_event_name":"Stop"}')).toEqual({status: 0, stdout: '', stderr: ''});
    });

    it('the status line runs the previous command with the same stdin', () => {
        const previous = 'printf "mine:%s" "$(cat)"';
        expect(sh(statusLineCommand(missing.statusLine, previous), '{"a":1}')).toMatchObject({status: 0, stdout: 'mine:{"a":1}'});
    });

    it('the status line prints nothing without a previous command', () => {
        expect(sh(statusLineCommand(missing.statusLine, null), '{}')).toEqual({status: 0, stdout: '', stderr: ''});
    });
});

describe('chainedPreviousCommand', () => {
    it('reads the previous command back', () => {
        expect(chainedPreviousCommand(statusLineCommand(scripts.statusLine, '~/bin/my-line.sh --short'))).toBe('~/bin/my-line.sh --short');
        expect(chainedPreviousCommand(statusLineCommand(scripts.statusLine, null))).toBeNull();
    });
});

describe('connectSettings', () => {
    it('creates the settings from nothing', () => {
        const settings = JSON.parse(connectSettings(null, scripts));
        expect(Object.keys(settings.hooks)).toEqual([...HOOK_EVENTS]);
        expect(settings.statusLine.command).toContain(BRIDGE_MARKER);
        expect(connectionStatus(JSON.stringify(settings))).toEqual({hooks: true, statusLine: true});
    });

    it('keeps every other key and the user\'s own hooks', () => {
        const original = JSON.stringify({
            theme: 'dark',
            enabledPlugins: {a: true},
            hooks: {Stop: [{hooks: [{type: 'command', command: '~/notify.sh'}]}], PreToolUse: [{matcher: 'Bash', hooks: []}]},
        });
        const settings = JSON.parse(connectSettings(original, scripts));
        expect(settings.theme).toBe('dark');
        expect(settings.enabledPlugins).toEqual({a: true});
        expect(settings.hooks.Stop[0]).toEqual({hooks: [{type: 'command', command: '~/notify.sh'}]});
        expect(settings.hooks.Stop).toHaveLength(2);
        expect(settings.hooks.PreToolUse).toEqual([{matcher: 'Bash', hooks: []}]);
    });

    it('chains an existing status line and keeps its other fields', () => {
        const original = JSON.stringify({statusLine: {type: 'command', command: '~/line.sh', padding: 2, refreshInterval: 10}});
        const {statusLine} = JSON.parse(connectSettings(original, scripts));
        expect(statusLine).toMatchObject({type: 'command', padding: 2, refreshInterval: 10});
        expect(chainedPreviousCommand(statusLine.command)).toBe('~/line.sh');
    });

    it('is idempotent', () => {
        const once = connectSettings('{"theme":"dark"}', scripts);
        expect(connectSettings(once, scripts)).toBe(once);
    });

    it.each([['invalid JSON', '{"theme": '], ['an array', '[]'], ['a string', '"x"']])('refuses %s', (_name, text) => {
        expect(() => connectSettings(text, scripts)).toThrow(SettingsError);
    });

    it('shows the planned entries without changing anything', () => {
        const planned = plannedEntries('{"statusLine":{"type":"command","command":"x"}}', scripts);
        expect(Object.keys(planned.hooks as object)).toEqual([...HOOK_EVENTS]);
        expect(chainedPreviousCommand((planned.statusLine as {command: string}).command)).toBe('x');
    });
});

describe('disconnectSettings', () => {
    it.each([
        ['nothing', null],
        ['other keys', '{\n  "theme": "dark"\n}\n'],
        ['own hooks and a status line', JSON.stringify({
            hooks: {Stop: [{hooks: [{type: 'command', command: '~/notify.sh'}]}]},
            statusLine: {type: 'command', command: '~/line.sh', padding: 1},
        }, null, 2) + '\n'],
    ])('connect then disconnect restores %s', (_name, original) => {
        const restored = disconnectSettings(connectSettings(original, scripts));
        expect(sameSettings(restored, original ?? '{}')).toBe(true);
        expect(connectionStatus(restored)).toEqual({hooks: false, statusLine: false});
        if (original)
            expect(restored).toBe(original);
    });

    it('keeps changes the user made while connected', () => {
        const connected = JSON.parse(connectSettings('{}', scripts));
        connected.model = 'opus';
        connected.hooks.Stop.push({hooks: [{type: 'command', command: '~/mine.sh'}]});
        const restored = JSON.parse(disconnectSettings(JSON.stringify(connected)));
        expect(restored).toEqual({model: 'opus', hooks: {Stop: [{hooks: [{type: 'command', command: '~/mine.sh'}]}]}});
    });

    it('refuses invalid JSON', () => {
        expect(() => disconnectSettings('nope')).toThrow(SettingsError);
    });
});

describe('connectionStatus', () => {
    it('is false for invalid or empty settings', () => {
        expect(connectionStatus('nope')).toEqual({hooks: false, statusLine: false});
        expect(connectionStatus(null)).toEqual({hooks: false, statusLine: false});
    });
});
