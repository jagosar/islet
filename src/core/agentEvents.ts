/** An event from a Claude Code session, reduced to the fields Islet uses. */
export interface AgentEvent {
    sessionId: string;
    cwd: string;
    hookEventName: string;
    notificationType?: string;
}

const MAX_FIELDS = 16;
const MAX_VALUE_LENGTH = 1024;

/**
 * Validates untrusted event fields (anything on the session bus can send them). Returns null
 * when required fields are missing, there are too many fields, or a value is too long.
 */
export function parseAgentEvent(fields: Record<string, string>): AgentEvent | null {
    const entries = Object.entries(fields);
    if (entries.length > MAX_FIELDS)
        return null;
    if (entries.some(([, value]) => typeof value !== 'string' || value.length > MAX_VALUE_LENGTH))
        return null;

    const {session_id: sessionId, cwd, hook_event_name: hookEventName, notification_type: notificationType} = fields;
    if (!sessionId || !cwd || !hookEventName)
        return null;

    return notificationType ? {sessionId, cwd, hookEventName, notificationType} : {sessionId, cwd, hookEventName};
}

/** The project name shown for a session: the last segment of its working directory. */
export function projectName(cwd: string): string {
    const segments = cwd.split('/').filter(Boolean);
    return segments.at(-1) ?? '/';
}

/**
 * The live activity text for an event, or null when the event should not interrupt the user.
 * `translate` is gettext in the Shell and the identity in tests.
 */
export function describeAgentEvent(event: AgentEvent, translate: (text: string) => string = text => text): string | null {
    const project = projectName(event.cwd);

    if (event.hookEventName === 'Notification') {
        switch (event.notificationType) {
        case 'permission_prompt':
            return translate('%s needs your permission').replace('%s', project);
        case 'idle_prompt':
        case 'agent_needs_input':
            return translate('%s is waiting for you').replace('%s', project);
        case 'agent_completed':
            return translate('%s finished').replace('%s', project);
        default:
            return null;
        }
    }

    if (event.hookEventName === 'Stop')
        return translate('%s finished').replace('%s', project);

    return null;
}
