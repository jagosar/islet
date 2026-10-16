// SPDX-License-Identifier: GPL-2.0-or-later
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Sandbox, sessionsOf, waitFor} from './harness.js';

const event = (session: string, name: string, extra: Record<string, string> = {}) =>
    ({session_id: session, cwd: '/home/me/code/demo', hook_event_name: name, ...extra});

describe('agent events and plan usage', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
        sandbox = await Sandbox.create();
        await sandbox.startDaemon();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('builds the sessions list from events', async () => {
        sandbox.call('ReportAgentEvent', event('a', 'UserPromptSubmit'));
        sandbox.call('ReportAgentEvent', event('b', 'Notification', {notification_type: 'permission_prompt'}));
        const sessions = await waitFor('two sessions', () => {
            const list = sessionsOf(sandbox.property('Sessions'));
            return list.length === 2 ? list : null;
        });
        expect(sessions.map(s => [s.sessionId, s.state])).toEqual([['b', 'needs-permission'], ['a', 'working']]);
        expect(sessions[0].project).toBe('demo');
    });

    it('removes a session on SessionEnd', async () => {
        sandbox.call('ReportAgentEvent', event('a', 'SessionEnd'));
        await waitFor('session a to go', () => sessionsOf(sandbox.property('Sessions')).every(s => s.sessionId !== 'a'));
    });

    it('re-emits valid events as signals, and ignores invalid ones', async () => {
        const events = await sandbox.watchEvents(3, async () => {
            sandbox.call('ReportAgentEvent', event('sig', 'Stop'));
            sandbox.call('ReportAgentEvent', {cwd: '/x'}); // No session id.
            sandbox.call('ReportAgentEvent', event('sig2', 'Stop', {extra: 'x'.repeat(2000)})); // Too long.
            await new Promise(done => setTimeout(done, 500));
        });
        expect(events.map(e => e.session_id)).toEqual(['sig']);
    });

    it('stores plan usage, exposes it and persists it for the next start', async () => {
        const now = Math.floor(Date.now() / 1000);
        sandbox.call('ReportPlanUsage', {
            five_hour_used_percentage: 33.5, five_hour_resets_at: now + 3600,
            seven_day_used_percentage: 4, seven_day_resets_at: now + 400_000,
        });
        const plan = await waitFor('the plan', () => (sandbox.property('PlanUsage') as {plan: {fiveHour?: {usedPercentage: number}} | null}).plan);
        expect(plan.fiveHour?.usedPercentage).toBe(33.5);

        await sandbox.stopDaemon();
        await sandbox.startDaemon();
        const restored = (sandbox.property('PlanUsage') as {plan: {fiveHour?: {usedPercentage: number}} | null}).plan;
        expect(restored?.fiveHour?.usedPercentage).toBe(33.5);
    });

    it('ignores invalid plan reports', () => {
        const before = JSON.stringify(sandbox.property('PlanUsage'));
        sandbox.call('ReportPlanUsage', {five_hour_used_percentage: 150, five_hour_resets_at: 1});
        sandbox.call('ReportPlanUsage', {bogus: 1});
        expect(JSON.stringify(sandbox.property('PlanUsage'))).toBe(before);
    });
});
