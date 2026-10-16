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

interface Tracked extends AgentSession {
    lastEventAt: number;
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
