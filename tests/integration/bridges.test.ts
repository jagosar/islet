// SPDX-License-Identifier: GPL-2.0-or-later
import {spawnSync} from 'node:child_process';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Sandbox, sessionsOf, waitFor} from './harness.js';

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('hook bridge', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
        sandbox = await Sandbox.create();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('exits 0 silently and quickly when Islet is not running', () => {
        const started = Date.now();
        const result = sandbox.gjs('bridge/hook.js', [], JSON.stringify({session_id: 's', cwd: '/x', hook_event_name: 'Stop'}));
        expect(result).toEqual({status: 0, stdout: '', stderr: ''});
        expect(Date.now() - started).toBeLessThan(3000);
    });

    it('forwards only the whitelisted fields, never prompts or replies', async () => {
        await sandbox.startDaemon();
        const events = await sandbox.watchEvents(3, async () => {
            const result = sandbox.gjs('bridge/hook.js', [], JSON.stringify({
                session_id: 'h1', cwd: '/home/me/code/demo', hook_event_name: 'Stop',
                last_assistant_message: 'PRIVATE REPLY', prompt: 'PRIVATE PROMPT', transcript_path: '/secret/path.jsonl',
            }));
            expect(result.status).toBe(0);
            await new Promise(done => setTimeout(done, 500));
        });
        expect(events).toEqual([{session_id: 'h1', cwd: '/home/me/code/demo', hook_event_name: 'Stop'}]);
        expect(JSON.stringify(events)).not.toMatch(/PRIVATE|secret/);
    });

    it('updates the sessions list', async () => {
        sandbox.gjs('bridge/hook.js', [], JSON.stringify({session_id: 'h2', cwd: '/home/me/code/web', hook_event_name: 'Notification', notification_type: 'permission_prompt'}));
        const sessions = await waitFor('the session', () => sessionsOf(sandbox.property('Sessions')).find(s => s.sessionId === 'h2'));
        expect(sessions).toMatchObject({project: 'web', state: 'needs-permission'});
    });

    it.each([['garbage', 'not json'], ['an array', '[]'], ['empty input', '']])('exits 0 and sends nothing for %s', async (_name, input) => {
        const events = await sandbox.watchEvents(2, () => {
            expect(sandbox.gjs('bridge/hook.js', [], input)).toEqual({status: 0, stdout: '', stderr: ''});
        });
        expect(events).toEqual([]);
    });
});

describe('status line bridge', () => {
    let sandbox: Sandbox;
    const now = Math.floor(Date.now() / 1000);
    const statusInput = JSON.stringify({
        session_id: 's', rate_limits: {five_hour: {used_percentage: 33.4, resets_at: now + 3600}, seven_day: {used_percentage: 4, resets_at: now + 400_000}},
    });

    beforeAll(async () => {
        sandbox = await Sandbox.create();
        await sandbox.startDaemon();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('prints a short status line and reports the plan to the daemon', async () => {
        const result = sandbox.gjs('bridge/statusline.js', [], statusInput);
        expect(result).toEqual({status: 0, stdout: '5h 33% · 7d 4%\n', stderr: ''});
        const plan = await waitFor('the plan', () => (sandbox.property('PlanUsage') as {plan: {fiveHour: {usedPercentage: number}} | null}).plan);
        expect(plan.fiveHour.usedPercentage).toBe(33.4);
    });

    it('chains the previous status line, giving it the same input', () => {
        const result = sandbox.gjs('bridge/statusline.js', [b64('printf "got:%s" "$(cat)"')], statusInput);
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(`got:${statusInput}\n`);
    });

    it('keeps the output of a previous command that never reads its input', () => {
        expect(sandbox.gjs('bridge/statusline.js', [b64('printf mine')], statusInput).stdout).toBe('mine\n');
        const big = JSON.stringify({padding: 'x'.repeat(400_000), ...JSON.parse(statusInput) as object});
        expect(sandbox.gjs('bridge/statusline.js', [b64('printf ok')], big).stdout).toBe('ok\n');
    });

    it('stops waiting for a previous command that hangs, still exits 0 and leaves no process behind', async () => {
        const started = Date.now();
        const result = sandbox.gjs('bridge/statusline.js', [b64('sleep 37; echo late')], statusInput);
        expect(result).toEqual({status: 0, stdout: '', stderr: ''});
        expect(Date.now() - started).toBeLessThan(9000);
        await waitFor('the hanging command to be ended', () => spawnSync('pgrep', ['-f', 'sleep 37']).status !== 0, 5000);
    });

    it('prints nothing for input without plan figures, and survives bad input', () => {
        expect(sandbox.gjs('bridge/statusline.js', [], '{"session_id":"s"}')).toEqual({status: 0, stdout: '', stderr: ''});
        expect(sandbox.gjs('bridge/statusline.js', [], 'not json')).toEqual({status: 0, stdout: '', stderr: ''});
    });

    it('works when Islet is not running', async () => {
        await sandbox.stopDaemon();
        expect(sandbox.gjs('bridge/statusline.js', [], statusInput)).toEqual({status: 0, stdout: '5h 33% · 7d 4%\n', stderr: ''});
    });
});
