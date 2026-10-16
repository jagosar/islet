import {describe, expect, it} from 'vitest';
import {
    lastDays, completeIfDue, decodeFocusState, formatCountdown, initialFocusState, pause, pruneHistory, remainingSeconds, resume, start, stop,
} from '../../src/core/focus.js';

const day = '2026-10-16';

describe('focus timer', () => {
    it('counts down while running', () => {
        const state = start(initialFocusState(), 25, 1000);
        expect(state.timer).toEqual({status: 'running', durationS: 1500, endsAt: 2500});
        expect(remainingSeconds(state.timer, 1100)).toBe(1400);
        expect(remainingSeconds(state.timer, 9999)).toBe(0);
    });

    it('freezes while paused and continues on resume', () => {
        let state = start(initialFocusState(), 25, 0);
        state = pause(state, 600);
        expect(remainingSeconds(state.timer, 5000)).toBe(900);
        state = resume(state, 5000);
        expect(state.timer).toEqual({status: 'running', durationS: 1500, endsAt: 5900});
    });

    it('ignores pause when not running and resume when not paused', () => {
        const idle = initialFocusState();
        expect(pause(idle, 1)).toBe(idle);
        const running = start(idle, 25, 0);
        expect(resume(running, 1)).toBe(running);
    });

    it('completes when due, booking a session on the end day', () => {
        const state = start(initialFocusState(), 25, 0);
        expect(completeIfDue(state, 1499, day).completed).toBe(false);
        const done = completeIfDue(state, 1500, day);
        expect(done.completed).toBe(true);
        expect(done.state.timer).toEqual({status: 'idle'});
        expect(done.state.history[day]).toEqual({minutes: 25, sessions: 1});
    });

    it('completes a session that ended while the Shell was not running', () => {
        const state = start(initialFocusState(), 50, 0);
        expect(completeIfDue(state, 999_999, '2026-10-15').state.history['2026-10-15']).toEqual({minutes: 50, sessions: 1});
    });

    it('counts the minutes of a stopped session, but not as a session', () => {
        let state = start(initialFocusState(), 25, 0);
        state = stop(state, 600, day);
        expect(state.timer).toEqual({status: 'idle'});
        expect(state.history[day]).toEqual({minutes: 10, sessions: 0});
        expect(stop(state, 700, day)).toBe(state);
    });

    it('adds to the same day', () => {
        let state = start(initialFocusState(), 25, 0);
        state = completeIfDue(state, 1500, day).state;
        state = completeIfDue(start(state, 50, 2000), 5000, day).state;
        expect(state.history[day]).toEqual({minutes: 75, sessions: 2});
    });

    it('prunes old days', () => {
        const state = {...initialFocusState(), history: {'2026-10-01': {minutes: 5, sessions: 1}, [day]: {minutes: 9, sessions: 0}}};
        expect(Object.keys(pruneHistory(state, [day]).history)).toEqual([day]);
    });
});

describe('lastDays', () => {
    it('lists today and the days before it, newest first, by calendar', () => {
        expect(lastDays('2026-10-16', 7)).toEqual(['2026-10-16', '2026-10-15', '2026-10-14', '2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10']);
    });

    it('crosses months, years and leap days', () => {
        expect(lastDays('2026-03-02', 4)).toEqual(['2026-03-02', '2026-03-01', '2026-02-28', '2026-02-27']);
        expect(lastDays('2028-03-01', 3)).toEqual(['2028-03-01', '2028-02-29', '2028-02-28']);
        expect(lastDays('2026-01-01', 2)).toEqual(['2026-01-01', '2025-12-31']);
    });

    it('never skips or repeats a day around a time change (regression: 24 h subtraction skipped Mar 29)', () => {
        for (const today of ['2026-03-30', '2026-03-29', '2026-10-26', '2026-10-25', '2026-11-02']) {
            const days = lastDays(today, 7);
            expect(new Set(days).size).toBe(7);
            for (let i = 1; i < days.length; i++)
                expect(Date.parse(`${days[i - 1]}T00:00:00Z`) - Date.parse(`${days[i]}T00:00:00Z`), today).toBe(86_400_000);
        }
    });
});

describe('formatCountdown', () => {
    it.each([[0, '0:00'], [59.2, '1:00'], [1122, '18:42'], [3900, '1:05:00']])('%d -> %s', (seconds, expected) => {
        expect(formatCountdown(seconds)).toBe(expected);
    });
});

describe('decodeFocusState', () => {
    it('round-trips a state', () => {
        const state = {...start(initialFocusState(), 25, 10), history: {[day]: {minutes: 5, sessions: 1}}};
        expect(decodeFocusState(JSON.stringify(state))).toEqual(state);
    });

    it.each([['garbage', 'x'], ['another version', '{"version":2}'], ['null', 'null']])('starts fresh from %s', (_n, text) => {
        expect(decodeFocusState(text)).toEqual(initialFocusState());
    });

    it('drops invalid parts and keeps the rest', () => {
        const text = JSON.stringify({version: 1, timer: {status: 'running', durationS: -5, endsAt: 9}, history: {bad: {minutes: 1, sessions: 1}, [day]: {minutes: 3, sessions: 0}}});
        expect(decodeFocusState(text)).toEqual({version: 1, timer: {status: 'idle'}, history: {[day]: {minutes: 3, sessions: 0}}});
    });
});
