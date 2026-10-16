// SPDX-License-Identifier: GPL-2.0-or-later

import {projectName, type AgentEvent} from './agentEvents.js';
import type {AgentSession, SessionState} from './protocol.js';

/** How long a session stays listed after its last event, by state (seconds). */
export const SESSION_EXPIRY: Record<SessionState, number> = {
    'needs-permission': 6 * 3600,
    'waiting': 6 * 3600,
    'working': 6 * 3600,
    'finished': 10 * 60,
    'idle': 60 * 60,
};

/** Most urgent first. */
const PRIORITY: SessionState[] = ['needs-permission', 'waiting', 'working', 'finished', 'idle'];

/** A session plus when it last had an event: what is saved across a restart. */
export interface TrackedSession extends AgentSession {
    lastEventAt: number;
}

type Tracked = TrackedSession;

const SNAPSHOT_VERSION = 1;
const STATES = Object.keys(SESSION_EXPIRY) as SessionState[];

export function encodeSessionSnapshot(sessions: TrackedSession[]): string {
    return JSON.stringify({version: SNAPSHOT_VERSION, sessions});
}

/** Reads a saved snapshot; anything unexpected reads as no sessions, and bad entries are skipped. */
export function decodeSessionSnapshot(text: string): TrackedSession[] {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return [];
    }
    if (typeof value !== 'object' || value === null || (value as {version?: unknown}).version !== SNAPSHOT_VERSION)
        return [];
    const list = (value as {sessions?: unknown}).sessions;
    if (!Array.isArray(list))
        return [];

    const time = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    const sessions: TrackedSession[] = [];
    for (const item of list as unknown[]) {
        if (typeof item !== 'object' || item === null)
            continue;
        const {sessionId, project, state, since, lastEventAt} = item as Record<string, unknown>;
        if (typeof sessionId === 'string' && typeof project === 'string' && STATES.includes(state as SessionState) && time(since) && time(lastEventAt))
            sessions.push({sessionId, project, state: state as SessionState, since, lastEventAt});
    }
    return sessions;
}

/** The state an event moves a session to, or null if the event says nothing about it. */
function nextState(event: AgentEvent): SessionState | null {
    switch (event.hookEventName) {
    case 'SessionStart':
        return 'idle';
    case 'UserPromptSubmit':
        return 'working';
    case 'Stop':
        return 'finished';
    case 'Notification':
        switch (event.notificationType) {
        case 'permission_prompt':
            return 'needs-permission';
        case 'idle_prompt':
        case 'agent_needs_input':
            return 'waiting';
        case 'agent_completed':
            return 'finished';
        default:
            return null;
        }
    default:
        return null;
    }
}

/**
 * The current Claude Code sessions, built from hook events.
 *
 * Hooks do not say when a permission is granted, so a session stays "needs permission" until
 * its next event (a reply ending, a new prompt or another notification). Sessions that never
 * send SessionEnd (a closed terminal, a crash) expire after SESSION_EXPIRY.
 */
export class SessionTracker {
    private readonly sessions = new Map<string, Tracked>();

    /** Every session with its last event time, for saving across a restart. */
    snapshot(): TrackedSession[] {
        return [...this.sessions.values()].map(session => ({...session}));
    }

    /** Loads a saved snapshot, dropping sessions that expired in the meantime. */
    restore(sessions: TrackedSession[], now: number): void {
        for (const session of sessions) {
            if (now - session.lastEventAt < SESSION_EXPIRY[session.state])
                this.sessions.set(session.sessionId, {...session});
        }
    }

    /** Applies an event; returns true if the list changed. */
    apply(event: AgentEvent, now: number): boolean {
        if (event.hookEventName === 'SessionEnd')
            return this.sessions.delete(event.sessionId);

        const state = nextState(event);
        if (!state)
            return false;

        const existing = this.sessions.get(event.sessionId);
        const project = projectName(event.cwd);
        if (existing && existing.state === state && existing.project === project) {
            existing.lastEventAt = now;
            return false;
        }
        this.sessions.set(event.sessionId, {
            sessionId: event.sessionId,
            project,
            state,
            since: existing?.state === state ? existing.since : now,
            lastEventAt: now,
        });
        return true;
    }

    /** Drops expired sessions; returns true if any was dropped. */
    expire(now: number): boolean {
        let changed = false;
        for (const [id, session] of this.sessions) {
            if (now - session.lastEventAt >= SESSION_EXPIRY[session.state]) {
                this.sessions.delete(id);
                changed = true;
            }
        }
        return changed;
    }

    /** Seconds until the next session expires, or null if there are none. */
    secondsUntilNextExpiry(now: number): number | null {
        let next: number | null = null;
        for (const session of this.sessions.values()) {
            const left = Math.max(0, session.lastEventAt + SESSION_EXPIRY[session.state] - now);
            next = next === null ? left : Math.min(next, left);
        }
        return next;
    }

    /** Sessions, most urgent first and, within a state, the most recent first. */
    list(): AgentSession[] {
        return [...this.sessions.values()]
            .sort((a, b) => PRIORITY.indexOf(a.state) - PRIORITY.indexOf(b.state) || b.since - a.since)
            .map(({sessionId, project, state, since}) => ({sessionId, project, state, since}));
    }
}
