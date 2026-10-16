// SPDX-License-Identifier: GPL-2.0-or-later
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Sandbox, sessionsOf, waitFor} from './harness.js';

describe('Claude Code connection (tools/claudeConnection.js)', () => {
    let sandbox: Sandbox;
    let settings: string;
    const cli = (command: string) => sandbox.gjs('tools/claudeConnection.js', [command]);
    const original = JSON.stringify({theme: 'dark', model: 'opus', hooks: {Stop: [{hooks: [{type: 'command', command: '~/notify.sh'}]}]}}, null, 2) + '\n';

    beforeAll(async () => {
        sandbox = await Sandbox.create();
        settings = join(sandbox.claude, 'settings.json');
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    const clean = () => rmSync(`${settings}.islet-backup`, {force: true});

    it('connects, saves a backup identical to the original, and keeps everything else', () => {
        writeFileSync(settings, original);
        expect(cli('connect').status).toBe(0);
        expect(readFileSync(`${settings}.islet-backup`, 'utf8')).toBe(original);
        const connected = JSON.parse(readFileSync(settings, 'utf8')) as {theme: string; hooks: Record<string, unknown[]>; statusLine: {command: string}};
        expect(connected.theme).toBe('dark');
        expect(connected.hooks.Stop).toHaveLength(2);
        expect(Object.keys(connected.hooks).sort()).toEqual(['Notification', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
        expect(cli('status').stdout).toContain('hooks connected, status line connected');
    });

    it('is idempotent', () => {
        const once = readFileSync(settings, 'utf8');
        expect(cli('connect').status).toBe(0);
        expect(readFileSync(settings, 'utf8')).toBe(once);
    });

    it('delivers events to the daemon through the command it wrote into settings.json', async () => {
        await sandbox.startDaemon();
        const parsed = JSON.parse(readFileSync(settings, 'utf8')) as {hooks: {Notification: {hooks: {command: string}[]}[]}};
        const command = parsed.hooks.Notification.flatMap(group => group.hooks)[0].command;
        expect(command).toContain('exec gjs -m');
        // The bridge path is the built dist/bridge/hook.js: the CLI derives it from its own location.
        const run = spawnSync('sh', ['-c', command], {
            env: sandbox.env(), encoding: 'utf8', timeout: 20_000,
            input: JSON.stringify({session_id: 'c1', cwd: '/home/me/code/demo', hook_event_name: 'Notification', notification_type: 'permission_prompt'}),
        });
        expect(run.status).toBe(0);
        expect(await waitFor('the session', () => sessionsOf(sandbox.property('Sessions')).find(s => s.sessionId === 'c1'))).toMatchObject({state: 'needs-permission'});
    });

    it('disconnects to the exact original bytes and removes the backup', () => {
        expect(cli('disconnect').status).toBe(0);
        expect(readFileSync(settings, 'utf8')).toBe(original);
        expect(existsSync(`${settings}.islet-backup`)).toBe(false);
    });

    it('chains an existing status line and restores it', () => {
        const withLine = JSON.stringify({statusLine: {type: 'command', command: 'printf mine', padding: 1}}, null, 4) + '\n';
        writeFileSync(settings, withLine);
        expect(cli('connect').status).toBe(0);
        const command = (JSON.parse(readFileSync(settings, 'utf8')) as {statusLine: {command: string; padding: number}}).statusLine;
        expect(command.padding).toBe(1);
        expect(cli('disconnect').status).toBe(0);
        expect(readFileSync(settings, 'utf8')).toBe(withLine);
    });

    it('keeps changes the user made while connected', () => {
        writeFileSync(settings, original);
        cli('connect');
        const connected = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
        connected.model = 'sonnet';
        writeFileSync(settings, JSON.stringify(connected, null, 2));
        cli('disconnect');
        const restored = JSON.parse(readFileSync(settings, 'utf8')) as Record<string, unknown>;
        expect(restored.model).toBe('sonnet');
        expect(JSON.stringify(restored)).not.toContain('islet@jagosar');
    });

    it('refuses invalid JSON and leaves the file untouched', () => {
        writeFileSync(settings, '{"theme": ');
        const result = cli('connect');
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/not valid JSON/);
        expect(readFileSync(settings, 'utf8')).toBe('{"theme": ');
        expect(existsSync(`${settings}.islet-backup`)).toBe(false);
    });

    it('creates the file when missing and removes it again on disconnect', () => {
        rmSync(settings, {force: true});
        clean();
        expect(cli('connect').status).toBe(0);
        expect(existsSync(settings)).toBe(true);
        expect(cli('disconnect').status).toBe(0);
        expect(existsSync(settings)).toBe(false);
    });

    describe('permissions (settings.json may hold API keys in env)', () => {
        const mode = (path: string) => statSync(path).mode & 0o777;
        const secret = JSON.stringify({env: {ANTHROPIC_API_KEY: 'sk-test'}}, null, 2) + '\n';

        it('keeps the backup as private as the original', () => {
            rmSync(`${settings}.islet-backup`, {force: true});
            writeFileSync(settings, secret);
            chmodSync(settings, 0o600);
            expect(cli('connect').status).toBe(0);
            expect(mode(`${settings}.islet-backup`)).toBe(0o600);
            expect(mode(settings)).toBe(0o600);
            cli('disconnect');
        });

        it('does not change the permissions of a settings file that already exists', () => {
            writeFileSync(settings, secret);
            chmodSync(settings, 0o644);
            cli('connect');
            expect(mode(settings)).toBe(0o644);
            expect(mode(`${settings}.islet-backup`)).toBe(0o600);
            cli('disconnect');
            expect(mode(settings)).toBe(0o644);
        });

        it('creates a settings file that did not exist as private', () => {
            rmSync(settings, {force: true});
            cli('connect');
            expect(mode(settings)).toBe(0o600);
            cli('disconnect');
        });

        it('tightens a backup left behind by version 0.1.0, which was world-readable', () => {
            writeFileSync(settings, secret);
            chmodSync(settings, 0o600);
            writeFileSync(`${settings}.islet-backup`, secret);
            chmodSync(`${settings}.islet-backup`, 0o664);
            expect(cli('status').status).toBe(0);
            expect(mode(`${settings}.islet-backup`)).toBe(0o600);
            rmSync(`${settings}.islet-backup`, {force: true});
        });
    });

    it('exits 2 for an unknown command', () => {
        expect(cli('frobnicate').status).toBe(2);
    });
});
