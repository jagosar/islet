// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The focus timer. Pure and clock-free: every operation takes `now` (Unix epoch seconds), so a
 * timer survives restarts by being stored and read back, and a session that ended while the
 * Shell was not running is completed on the next read.
 */

export const FOCUS_PRESETS_MIN = [25, 50, 90] as const;
/** Days of history kept (today and the six before it). */
export const FOCUS_HISTORY_DAYS = 7;

export type FocusTimer =
    | {status: 'idle'}
    | {status: 'running'; durationS: number; endsAt: number}
    | {status: 'paused'; durationS: number; remainingS: number};

export interface FocusDay {
    minutes: number;
    sessions: number;
}

export interface FocusState {
    version: 1;
    timer: FocusTimer;
    /** Keyed by local day, YYYY-MM-DD. */
    history: Record<string, FocusDay>;
}

export function initialFocusState(): FocusState {
    return {version: 1, timer: {status: 'idle'}, history: {}};
}

export function remainingSeconds(timer: FocusTimer, now: number): number {
    switch (timer.status) {
    case 'running':
        return Math.max(0, timer.endsAt - now);
    case 'paused':
        return timer.remainingS;
    case 'idle':
        return 0;
    }
}

function record(state: FocusState, day: string, seconds: number, completed: boolean): FocusState {
    const previous = state.history[day] ?? {minutes: 0, sessions: 0};
    return {
        ...state,
        history: {
            ...state.history,
            [day]: {minutes: previous.minutes + Math.round(seconds / 60), sessions: previous.sessions + (completed ? 1 : 0)},
        },
    };
}

export function start(state: FocusState, minutes: number, now: number): FocusState {
    const durationS = Math.round(minutes * 60);
    return {...state, timer: {status: 'running', durationS, endsAt: now + durationS}};
}

export function pause(state: FocusState, now: number): FocusState {
    const {timer} = state;
    if (timer.status !== 'running')
        return state;
    return {...state, timer: {status: 'paused', durationS: timer.durationS, remainingS: remainingSeconds(timer, now)}};
}

export function resume(state: FocusState, now: number): FocusState {
    const {timer} = state;
    if (timer.status !== 'paused')
        return state;
    return {...state, timer: {status: 'running', durationS: timer.durationS, endsAt: now + timer.remainingS}};
}

/** Stops early: the minutes focused so far count, but not as a completed session. */
export function stop(state: FocusState, now: number, day: string): FocusState {
    const {timer} = state;
    if (timer.status === 'idle')
        return state;
    const focused = timer.durationS - remainingSeconds(timer, now);
    return {...record(state, day, focused, false), timer: {status: 'idle'}};
}

/**
 * Completes a running timer whose time is up, booking it on `endDay` (the local day of
 * `endsAt`). Returns the state unchanged, and `completed` false, otherwise.
 */
export function completeIfDue(state: FocusState, now: number, endDay: string): {state: FocusState; completed: boolean} {
    const {timer} = state;
    if (timer.status !== 'running' || now < timer.endsAt)
        return {state, completed: false};
    return {state: {...record(state, endDay, timer.durationS, true), timer: {status: 'idle'}}, completed: true};
}

/** Drops days older than the FOCUS_HISTORY_DAYS ending on `today` (`days` lists them). */
export function pruneHistory(state: FocusState, keptDays: string[]): FocusState {
    const keep = new Set(keptDays);
    return {...state, history: Object.fromEntries(Object.entries(state.history).filter(([day]) => keep.has(day)))};
}

/** "18:42", or "1:05:00" from an hour. */
export function formatCountdown(seconds: number): string {
    const s = Math.max(0, Math.ceil(seconds));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const rest = String(s % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** Validates a stored state; anything unexpected becomes a fresh state. */
export function decodeFocusState(text: string): FocusState {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return initialFocusState();
    }
    if (typeof value !== 'object' || value === null || (value as {version?: unknown}).version !== 1)
        return initialFocusState();
    const {timer, history} = value as {timer?: Record<string, unknown>; history?: unknown};
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

    let decodedTimer: FocusTimer = {status: 'idle'};
    if (timer?.status === 'running' && n(timer.durationS) && n(timer.endsAt))
        decodedTimer = {status: 'running', durationS: timer.durationS as number, endsAt: timer.endsAt as number};
    else if (timer?.status === 'paused' && n(timer.durationS) && n(timer.remainingS))
        decodedTimer = {status: 'paused', durationS: timer.durationS as number, remainingS: timer.remainingS as number};

    const decodedHistory: Record<string, FocusDay> = {};
    if (typeof history === 'object' && history !== null) {
        for (const [day, entry] of Object.entries(history)) {
            const e = entry as Record<string, unknown> | null; // A JSON null is possible.
            if (e && /^\d{4}-\d{2}-\d{2}$/.test(day) && n(e.minutes) && n(e.sessions))
                decodedHistory[day] = {minutes: e.minutes as number, sessions: e.sessions as number};
        }
    }
    return {version: 1, timer: decodedTimer, history: decodedHistory};
}
