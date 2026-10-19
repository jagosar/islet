import {describe, expect, it} from 'vitest';
import {
    LIVE_ACTIVITY_MS, LIVE_ACTIVITY_STALE_MS, LiveQueue, compactView, liveActivityForAgentEvent, planThresholdCrossed,
    type IslandInput, type LiveActivity,
} from '../../src/core/island.js';
import type {AgentSession, PlanUsage} from '../../src/core/protocol.js';

const now = 1_792_150_000;
const base: IslandInput = {available: true, usage: null, plan: null, sessions: [], now};
const session = (id: string, project: string, state: AgentSession['state']): AgentSession => ({sessionId: id, project, state, since: now});

describe('compactView', () => {
    it('shows Claude usage when nothing needs the user', () => {
        const plan: PlanUsage = {measuredAt: now, fiveHour: {usedPercentage: 33, resetsAt: now + 100}};
        expect(compactView({...base, plan, sessions: [session('a', 'islet', 'working')]}))
            .toEqual({text: 'Claude 33%', tone: 'normal'});
    });

    it('puts a session waiting for permission first', () => {
        expect(compactView({...base, sessions: [session('a', 'islet', 'needs-permission'), session('b', 'web', 'working')]}))
            .toEqual({text: 'islet needs permission', tone: 'attention'});
    });

    it('names a session waiting for input', () => {
        expect(compactView({...base, sessions: [session('a', 'web', 'waiting')]}))
            .toEqual({text: 'web is waiting', tone: 'attention'});
    });

    it('counts several sessions that need the user', () => {
        expect(compactView({...base, sessions: [session('a', 'islet', 'needs-permission'), session('b', 'web', 'waiting')]}))
            .toEqual({text: '2 sessions need you', tone: 'attention'});
    });

    it('is muted while the daemon is unavailable, whatever the Claude data', () => {
        expect(compactView({...base, available: false, sessions: [session('a', 'islet', 'needs-permission')]}))
            .toEqual({text: 'Claude', tone: 'muted'});
    });

    it('shows a running focus session before Claude usage, and after sessions that need the user', () => {
        const plan: PlanUsage = {measuredAt: now, fiveHour: {usedPercentage: 33, resetsAt: now + 100}};
        const focus = {remainingS: 1122, paused: false};
        expect(compactView({...base, plan, focus})).toEqual({text: 'Focus 18:42', tone: 'normal'});
        expect(compactView({...base, focus: {...focus, paused: true}})).toEqual({text: 'Focus paused · 18:42', tone: 'muted'});
        expect(compactView({...base, focus, sessions: [session('a', 'islet', 'waiting')]}).text).toBe('islet is waiting');
    });

    it('keeps focus working without the daemon', () => {
        expect(compactView({...base, available: false, focus: {remainingS: 60, paused: false}}).text).toBe('Focus 1:00');
    });

    it('shows what is playing only when Claude has nothing to show', () => {
        const plan: PlanUsage = {measuredAt: now, fiveHour: {usedPercentage: 33, resetsAt: now + 100}};
        expect(compactView({...base, nowPlaying: 'Song — Band'})).toEqual({text: '♪ Song — Band', tone: 'normal'});
        expect(compactView({...base, plan, nowPlaying: 'Song — Band'}).text).toBe('Claude 33%');
        expect(compactView({...base, available: false, nowPlaying: 'Song — Band'}).text).toBe('♪ Song — Band');
    });

    it('translates', () => {
        expect(compactView({...base, sessions: [session('a', 'islet', 'waiting')]}, () => '%s espera').text).toBe('islet espera');
    });
});

describe('liveActivityForAgentEvent', () => {
    const event = (hookEventName: string, notificationType?: string) =>
        ({sessionId: 's', cwd: '/home/me/code/islet', hookEventName, notificationType});

    it.each([
        [event('Notification', 'permission_prompt'), {text: 'islet needs your permission', tone: 'attention', priority: 3}],
        [event('Notification', 'idle_prompt'), {text: 'islet is waiting for you', tone: 'attention', priority: 2}],
        [event('Stop'), {text: 'islet finished', tone: 'normal', priority: 1}],
    ])('%o', (e, expected) => {
        expect(liveActivityForAgentEvent(e)).toEqual({key: 'session:s', ...expected});
    });

    it('ignores events that should not interrupt', () => {
        expect(liveActivityForAgentEvent(event('SessionStart'))).toBeNull();
        expect(liveActivityForAgentEvent(event('UserPromptSubmit'))).toBeNull();
    });
});

describe('compact view with an estimate', () => {
    const plan: PlanUsage = {measuredAt: now - 60, source: 'desktop', fiveHour: {usedPercentage: 27}};
    const input = (estimate: IslandInput['estimate']): IslandInput =>
        ({available: true, usage: null, plan, estimate, sessions: [], now});

    it('shows the estimate with a tilde', () => {
        expect(compactView(input({fiveHour: 33, basedOn: plan.measuredAt, at: now})).text).toBe('Claude ≈33%');
    });

    it('does not show an estimate of another reading', () => {
        expect(compactView(input({fiveHour: 33, basedOn: plan.measuredAt - 900, at: now})).text).toBe('Claude 27%');
    });
});

describe('planThresholdCrossed', () => {
    const plan = (used: number, resetsAt = now + 1000): PlanUsage => ({measuredAt: now, fiveHour: {usedPercentage: used, resetsAt}});

    it.each([
        [plan(70), plan(76), 75],
        [plan(70), plan(95), 90],
        [plan(80), plan(91), 90],
        [plan(76), plan(80), null],
        [plan(91), plan(95), null],
        [null, plan(80), 75],
        [plan(80), plan(70), null],
        [plan(95, now + 10), plan(80, now + 20000), 75],
        [plan(70), {measuredAt: now}, null],
        [plan(95), plan(100), 100],
        [plan(91, undefined), {measuredAt: now, source: 'desktop', fiveHour: {usedPercentage: 100}}, 100],
        [{measuredAt: now, fiveHour: {usedPercentage: 70}}, {measuredAt: now, fiveHour: {usedPercentage: 80}}, 75],
    ])('%o -> %o: %s', (previous, next, expected) => {
        expect(planThresholdCrossed(previous, next)).toBe(expected);
    });
});

describe('LiveQueue', () => {
    const activity = (key: string, priority: number): LiveActivity => ({key, text: key, tone: 'normal', priority});

    it('shows an activity for LIVE_ACTIVITY_MS', () => {
        const queue = new LiveQueue();
        expect(queue.push(activity('a', 1), 0)).toBe(true);
        expect(queue.nextChangeAt()).toBe(LIVE_ACTIVITY_MS);
        expect(queue.tick(LIVE_ACTIVITY_MS - 1)).toBe(false);
        expect(queue.tick(LIVE_ACTIVITY_MS)).toBe(true);
        expect(queue.shown).toBeNull();
        expect(queue.nextChangeAt()).toBeNull();
    });

    it('lets a more important activity interrupt', () => {
        const queue = new LiveQueue();
        queue.push(activity('song', 0), 0);
        expect(queue.push(activity('permission', 3), 100)).toBe(true);
        expect(queue.shown?.key).toBe('permission');
        queue.tick(100 + LIVE_ACTIVITY_MS);
        expect(queue.shown).toBeNull();
    });

    it('queues a less important activity behind the current one, by priority', () => {
        const queue = new LiveQueue();
        queue.push(activity('permission', 3), 0);
        expect(queue.push(activity('song', 0), 10)).toBe(false);
        queue.push(activity('finished', 1), 20);
        queue.tick(LIVE_ACTIVITY_MS);
        expect(queue.shown?.key).toBe('finished');
        queue.tick(2 * LIVE_ACTIVITY_MS);
        expect(queue.shown?.key).toBe('song');
    });

    it('replaces an activity with the same key instead of queueing it', () => {
        const queue = new LiveQueue();
        queue.push(activity('a', 1), 0);
        queue.push({...activity('a', 1), text: 'newer'}, 1000);
        expect(queue.shown?.text).toBe('newer');
        expect(queue.nextChangeAt()).toBe(1000 + LIVE_ACTIVITY_MS);
    });

    it('drops queued activities once they are stale', () => {
        const queue = new LiveQueue();
        queue.push(activity('current', 3), 0);
        queue.push(activity('old news', 0), 0);
        expect(queue.tick(LIVE_ACTIVITY_STALE_MS)).toBe(true);
        expect(queue.shown).toBeNull();
    });

    it('keeps at most three waiting', () => {
        const queue = new LiveQueue();
        queue.push(activity('current', 9), 0);
        for (const key of ['a', 'b', 'c', 'd'])
            queue.push(activity(key, 1), 1);
        const shownKeys: string[] = [];
        for (let t = LIVE_ACTIVITY_MS; queue.tick(t) && queue.shown; t += LIVE_ACTIVITY_MS)
            shownKeys.push(queue.shown.key);
        expect(shownKeys).toEqual(['a', 'b', 'c']);
    });
});
