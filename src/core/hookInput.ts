// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * The only hook input fields that leave the hook process. Everything else Claude Code sends
 * (messages, prompts, tool input, the last assistant message) stays behind.
 */
const FORWARDED_FIELDS = ['session_id', 'cwd', 'hook_event_name', 'notification_type'] as const;

/** Picks the forwarded string fields from a hook's stdin JSON; null if it is not a JSON object. */
export function hookFieldsFromJson(text: string): Record<string, string> | null {
    let input: unknown;
    try {
        input = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input))
        return null;

    const fields: Record<string, string> = {};
    for (const key of FORWARDED_FIELDS) {
        const value = (input as Record<string, unknown>)[key];
        if (typeof value === 'string')
            fields[key] = value;
    }
    return fields;
}
