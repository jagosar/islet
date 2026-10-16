// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * GNOME Shell switches extensions off while the screen is locked, which stops the daemon. Claude
 * Code keeps working meanwhile, and its hooks must not be lost: the bridges leave what they could
 * not deliver in a spool, the daemon saves its sessions, and both are restored on the next start.
 */
import {existsSync, mkdirSync, readdirSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {spoolFileName} from '../../src/core/spool.js';
import {Sandbox, sessionsOf, waitFor} from './harness.js';

const hook = (sandbox: Sandbox, session: string, name: string, extra: Record<string, string> = {}, cwd = '/home/me/code/demo') =>
    sandbox.gjs('bridge/hook.js', [], JSON.stringify({session_id: session, cwd, hook_event_name: name, ...extra}));

describe('while the daemon is not running (screen locked)', () => {
    let sandbox: Sandbox;
    const spool = () => join(sandbox.runtime, 'islet', 'spool');
    const spooled = () => (existsSync(spool()) ? readdirSync(spool()) : []);

    beforeAll(async () => {
        sandbox = await Sandbox.create();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('keeps the sessions it knew across a restart, and replays what happened meanwhile', async () => {
        await sandbox.startDaemon();
        hook(sandbox, 'before', 'UserPromptSubmit', {}, '/home/me/code/alpha');
        hook(sandbox, 'finishing', 'UserPromptSubmit', {}, '/home/me/code/beta');
        await waitFor('both sessions', () => sessionsOf(sandbox.property('Sessions')).length === 2);

        await sandbox.stopDaemon(); // The screen locks.
        expect(hook(sandbox, 'finishing', 'Stop', {}, '/home/me/code/beta')).toEqual({status: 0, stdout: '', stderr: ''});
        expect(hook(sandbox, 'new', 'Notification', {notification_type: 'permission_prompt'}, '/home/me/code/gamma').status).toBe(0);
        expect(spooled()).toHaveLength(2);

        await sandbox.startDaemon(); // The screen unlocks.
        const sessions = await waitFor('the replayed state', () => {
            const list = sessionsOf(sandbox.property('Sessions'));
            return list.length === 3 ? list : null;
        });
        expect(Object.fromEntries(sessions.map(s => [s.sessionId, s.state]))).toEqual({
            before: 'working', finishing: 'finished', new: 'needs-permission',
        });
        expect(sessions.find(s => s.sessionId === 'new')?.project).toBe('gamma');
        await waitFor('the spool to be emptied', () => spooled().length === 0);
    });

    it('does not turn replayed events into live-activity signals', async () => {
        await sandbox.stopDaemon();
        hook(sandbox, 'quiet', 'Stop');
        await sandbox.startDaemon();
        const events = await sandbox.watchEvents(2, () => undefined);
        expect(events).toEqual([]);
        await waitFor('the replayed session', () => sessionsOf(sandbox.property('Sessions')).some(s => s.sessionId === 'quiet'));
    });

    it('replays events in the order they happened, using their own times', async () => {
        await sandbox.stopDaemon();
        hook(sandbox, 'ordered', 'UserPromptSubmit');
        hook(sandbox, 'ordered', 'Notification', {notification_type: 'permission_prompt'});
        hook(sandbox, 'ordered', 'Stop');
        await sandbox.startDaemon();
        const session = await waitFor('the session', () => sessionsOf(sandbox.property('Sessions')).find(s => s.sessionId === 'ordered'));
        expect(session.state).toBe('finished');
    });

    it('restores the last plan usage reported while it was away', async () => {
        await sandbox.stopDaemon();
        const now = Math.floor(Date.now() / 1000);
        const input = JSON.stringify({rate_limits: {five_hour: {used_percentage: 61, resets_at: now + 3600}}});
        expect(sandbox.gjs('bridge/statusline.js', [], input).stdout).toBe('5h 61%\n');
        await sandbox.startDaemon();
        const plan = await waitFor('the plan', () => (sandbox.property('PlanUsage') as {plan: {fiveHour: {usedPercentage: number}} | null}).plan);
        expect(plan.fiveHour.usedPercentage).toBe(61);
    });

    it('ignores stale, damaged and foreign files in the spool, and removes them', async () => {
        await sandbox.stopDaemon();
        mkdirSync(spool(), {recursive: true});
        const old = Math.floor(Date.now() / 1000) - 7 * 3600;
        writeFileSync(join(spool(), spoolFileName(old, 1, 'agent-event')), JSON.stringify({kind: 'agent-event', at: old, fields: {session_id: 'stale', cwd: '/x', hook_event_name: 'Stop'}}));
        writeFileSync(join(spool(), spoolFileName(Math.floor(Date.now() / 1000), 2, 'agent-event')), 'not json at all');
        writeFileSync(join(spool(), 'readme.txt'), 'hello');
        await sandbox.startDaemon();
        await waitFor('the spool to be cleaned', () => !spooled().some(name => name.endsWith('.json')));
        expect(sessionsOf(sandbox.property('Sessions')).some(s => s.sessionId === 'stale')).toBe(false);
        expect(existsSync(join(spool(), 'readme.txt'))).toBe(true); // Not ours: left alone.
    });

    it('keeps the spool private, and bounded', async () => {
        await sandbox.stopDaemon();
        hook(sandbox, 'priv', 'Stop');
        const [file] = spooled().filter(name => name.endsWith('.json'));
        expect(statSync(join(spool(), file)).mode & 0o777).toBe(0o600);
        expect(statSync(spool()).mode & 0o777).toBe(0o700);
    });

    it('does not fail the hook when there is nowhere to spool', () => {
        const result = sandbox.gjs('bridge/hook.js', [], JSON.stringify({session_id: 'x', cwd: '/x', hook_event_name: 'Stop'}), {XDG_RUNTIME_DIR: '/nonexistent/run'});
        expect(result).toEqual({status: 0, stdout: '', stderr: ''});
    });
});
