// SPDX-License-Identifier: GPL-2.0-or-later
import {spawn} from 'node:child_process';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Sandbox, sessionsOf, sleep, waitFor} from './harness.js';

describe('limits on what any process of the user can ask of the daemon', () => {
    let sandbox: Sandbox;
    const now = Math.floor(Date.now() / 1000);
    const figures = (percent: number) => JSON.stringify({five_hour_used_percentage: percent, five_hour_resets_at: now + 3600});

    beforeAll(async () => {
        sandbox = await Sandbox.create();
        await sandbox.startDaemon();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    /** Names of the properties announced while `work` runs. */
    async function changedProperties(work: () => void): Promise<string[]> {
        const watcher = spawn('gjs', ['-m', new URL('./client.js', import.meta.url).pathname, 'watch-properties', '4'], {env: sandbox.env(), stdio: ['ignore', 'pipe', 'inherit']});
        let out = '';
        watcher.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        await waitFor('the watcher', () => out.includes('ready'));
        work();
        await new Promise(done => watcher.once('exit', done));
        return out.split('\n').filter(name => name && name !== 'ready');
    }

    it('announces unchanged plan figures once, not on every status line run', async () => {
        const announced = await changedProperties(() => {
            expect(sandbox.run('flood-plan', '30', figures(40)).status).toBe(0);
        });
        expect(announced.filter(name => name === 'PlanUsage')).toHaveLength(1);
    });

    it('announces a change in the figures at once', async () => {
        const announced = await changedProperties(() => {
            sandbox.run('flood-plan', '3', figures(41));
            sandbox.run('flood-plan', '3', figures(42));
        });
        expect(announced.filter(name => name === 'PlanUsage')).toHaveLength(2);
        expect((sandbox.property('PlanUsage') as {plan: {fiveHour: {usedPercentage: number}}}).plan.fiveHour.usedPercentage).toBe(42);
    });

    it('does not rewrite the saved plan for unchanged figures', async () => {
        const path = `${sandbox.state}/islet/plan-usage.json`;
        sandbox.run('flood-plan', '1', figures(43));
        const first = sandbox.read(path);
        await sleep(1100);
        sandbox.run('flood-plan', '20', figures(43));
        expect(sandbox.read(path)).toBe(first); // Same measuredAt: not written again.
    });

    it('drops a flood of events beyond its burst, keeps working, and says so once', async () => {
        const result = sandbox.run('flood-events', '600');
        expect(result.status).toBe(0);
        const accepted = sessionsOf(sandbox.property('Sessions')).length;
        expect(accepted).toBeGreaterThan(50);
        expect(accepted).toBeLessThan(250);
        await waitFor('the warning', () => /too many agent events/.test(sandbox.daemonLog));
        expect(sandbox.daemonLog.match(/too many agent events/g)).toHaveLength(1);

        await sleep(2500); // The bucket refills.
        sandbox.call('ReportAgentEvent', {session_id: 'after-the-flood', cwd: '/home/me/code/calm', hook_event_name: 'UserPromptSubmit'});
        await waitFor('a normal event to be accepted again', () => sessionsOf(sandbox.property('Sessions')).some(s => s.sessionId === 'after-the-flood'));
    });
});
