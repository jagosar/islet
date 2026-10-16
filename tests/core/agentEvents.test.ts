import {describe, expect, it} from 'vitest';
import {describeAgentEvent, parseAgentEvent, projectName} from '../../src/core/agentEvents.js';

const base = {session_id: 'abc', cwd: '/home/me/code/islet', hook_event_name: 'Notification'};

describe('parseAgentEvent', () => {
    it('keeps the fields Islet uses', () => {
        expect(parseAgentEvent({...base, notification_type: 'permission_prompt', extra: 'ignored'})).toEqual({
            sessionId: 'abc',
            cwd: '/home/me/code/islet',
            hookEventName: 'Notification',
            notificationType: 'permission_prompt',
        });
    });

    it('omits a missing notification type', () => {
        expect(parseAgentEvent({...base, hook_event_name: 'Stop'})).toEqual({
            sessionId: 'abc', cwd: '/home/me/code/islet', hookEventName: 'Stop',
        });
    });

    it.each(['session_id', 'cwd', 'hook_event_name'])('rejects an event without %s', key => {
        const fields: Record<string, string> = {...base};
        delete fields[key];
        expect(parseAgentEvent(fields)).toBeNull();
    });

    it('rejects oversized input', () => {
        expect(parseAgentEvent({...base, cwd: 'x'.repeat(1025)})).toBeNull();
        const many = Object.fromEntries(Array.from({length: 17}, (_, i) => [`k${i}`, 'v']));
        expect(parseAgentEvent({...base, ...many})).toBeNull();
    });
});

describe('projectName', () => {
    it.each([
        ['/home/me/code/islet', 'islet'],
        ['/home/me/code/islet/', 'islet'],
        ['/', '/'],
    ])('%s -> %s', (cwd, expected) => {
        expect(projectName(cwd)).toBe(expected);
    });
});

describe('describeAgentEvent', () => {
    const event = (hookEventName: string, notificationType?: string) =>
        ({sessionId: 'abc', cwd: '/home/me/code/islet', hookEventName, notificationType});

    it.each([
        [event('Notification', 'permission_prompt'), 'islet needs your permission'],
        [event('Notification', 'idle_prompt'), 'islet is waiting for you'],
        [event('Notification', 'agent_needs_input'), 'islet is waiting for you'],
        [event('Notification', 'agent_completed'), 'islet finished'],
        [event('Stop'), 'islet finished'],
        [event('Notification', 'auth_success'), null],
        [event('SessionStart'), null],
    ])('%o -> %s', (input, expected) => {
        expect(describeAgentEvent(input)).toBe(expected);
    });
});
