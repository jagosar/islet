import {beforeEach, describe, expect, it} from 'vitest';
import type {AgentEvent} from '../../src/core/agentEvents.js';
import {SESSION_EXPIRY, SessionTracker, decodeSessionSnapshot, encodeSessionSnapshot} from '../../src/core/sessions.js';

function event(hookEventName: string, notificationType?: string, sessionId = 'a', cwd = '/home/me/code/islet'): AgentEvent {
    return notificationType ? {sessionId, cwd, hookEventName, notificationType} : {sessionId, cwd, hookEventName};
}

describe('SessionTracker', () => {
    let tracker: SessionTracker;
    beforeEach(() => {
        tracker = new SessionTracker();
    });

    it.each([
        [event('SessionStart'), 'idle'],
        [event('UserPromptSubmit'), 'working'],
        [event('Notification', 'permission_prompt'), 'needs-permission'],
        [event('Notification', 'idle_prompt'), 'waiting'],
        [event('Notification', 'agent_needs_input'), 'waiting'],
        [event('Notification', 'agent_completed'), 'finished'],
        [event('Stop'), 'finished'],
    ])('%o puts the session in %s', (e, state) => {
        expect(tracker.apply(e, 100)).toBe(true);
        expect(tracker.list()).toEqual([{sessionId: 'a', project: 'islet', state, since: 100}]);
    });

    it('follows a whole turn', () => {
        tracker.apply(event('SessionStart'), 1);
        tracker.apply(event('UserPromptSubmit'), 2);
        tracker.apply(event('Notification', 'permission_prompt'), 3);
        expect(tracker.list()[0].state).toBe('needs-permission');
        tracker.apply(event('Stop'), 9);
        expect(tracker.list()[0]).toMatchObject({state: 'finished', since: 9});
    });

    it('ignores events that say nothing about the state', () => {
        expect(tracker.apply(event('Notification', 'auth_success'), 1)).toBe(false);
        expect(tracker.apply(event('PreCompact'), 1)).toBe(false);
        expect(tracker.list()).toEqual([]);
    });

    it('keeps "since" when the state repeats, and reports no change', () => {
        tracker.apply(event('UserPromptSubmit'), 10);
        expect(tracker.apply(event('UserPromptSubmit'), 20)).toBe(false);
        expect(tracker.list()[0].since).toBe(10);
    });

    it('removes a session on SessionEnd', () => {
        tracker.apply(event('UserPromptSubmit'), 1);
        expect(tracker.apply(event('SessionEnd'), 2)).toBe(true);
        expect(tracker.list()).toEqual([]);
        expect(tracker.apply(event('SessionEnd'), 3)).toBe(false);
    });

    it('accepts events out of order (a Stop for a session it never saw start)', () => {
        expect(tracker.apply(event('Stop', undefined, 'late'), 5)).toBe(true);
        expect(tracker.list()).toEqual([{sessionId: 'late', project: 'islet', state: 'finished', since: 5}]);
    });

    it('lists the most urgent session first, then the most recent', () => {
        tracker.apply(event('Stop', undefined, 'done'), 1);
        tracker.apply(event('UserPromptSubmit', undefined, 'old'), 2);
        tracker.apply(event('UserPromptSubmit', undefined, 'new'), 3);
        tracker.apply(event('Notification', 'permission_prompt', 'ask'), 4);
        expect(tracker.list().map(s => s.sessionId)).toEqual(['ask', 'new', 'old', 'done']);
    });

    it('expires sessions by state and tells when the next one expires', () => {
        tracker.apply(event('Stop', undefined, 'done'), 0);
        tracker.apply(event('UserPromptSubmit', undefined, 'busy'), 0);
        expect(tracker.secondsUntilNextExpiry(0)).toBe(SESSION_EXPIRY.finished);

        expect(tracker.expire(SESSION_EXPIRY.finished - 1)).toBe(false);
        expect(tracker.expire(SESSION_EXPIRY.finished)).toBe(true);
        expect(tracker.list().map(s => s.sessionId)).toEqual(['busy']);
        expect(tracker.secondsUntilNextExpiry(SESSION_EXPIRY.finished)).toBe(SESSION_EXPIRY.working - SESSION_EXPIRY.finished);
    });

    describe('persistence across a restart', () => {
        it('restores sessions with their state, start time and last event', () => {
            tracker.apply(event('UserPromptSubmit', undefined, 'a'), 100);
            tracker.apply(event('Notification', 'permission_prompt', 'b'), 200);
            const restored = new SessionTracker();
            restored.restore(decodeSessionSnapshot(encodeSessionSnapshot(tracker.snapshot())), 300);
            expect(restored.list()).toEqual(tracker.list());
            expect(restored.secondsUntilNextExpiry(300)).toBe(tracker.secondsUntilNextExpiry(300));
        });

        it('drops sessions that expired while the daemon was not running', () => {
            tracker.apply(event('Stop', undefined, 'done'), 0);
            tracker.apply(event('UserPromptSubmit', undefined, 'busy'), 0);
            const restored = new SessionTracker();
            restored.restore(tracker.snapshot(), SESSION_EXPIRY.finished + 1);
            expect(restored.list().map(s => s.sessionId)).toEqual(['busy']);
        });

        it.each([['garbage', 'nope'], ['another version', '{"version":2,"sessions":[]}'], ['not a list', '{"version":1,"sessions":{}}']])('reads %s as nothing', (_n, text) => {
            expect(decodeSessionSnapshot(text)).toEqual([]);
        });

        it('keeps valid entries and drops invalid ones', () => {
            const text = JSON.stringify({version: 1, sessions: [
                {sessionId: 'ok', project: 'p', state: 'working', since: 1, lastEventAt: 2},
                {sessionId: 'bad', project: 'p', state: 'sleeping', since: 1, lastEventAt: 2},
                {sessionId: 'worse', project: 'p', state: 'working', since: 'x', lastEventAt: 2},
            ]});
            expect(decodeSessionSnapshot(text).map(s => s.sessionId)).toEqual(['ok']);
        });
    });

    it('has no expiry when empty', () => {
        expect(tracker.secondsUntilNextExpiry(0)).toBeNull();
    });
});
