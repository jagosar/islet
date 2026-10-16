import {describe, expect, it} from 'vitest';
import {hookFieldsFromJson} from '../../src/core/hookInput.js';

describe('hookFieldsFromJson', () => {
    it('forwards only the whitelisted fields of a Notification', () => {
        const input = {
            session_id: 'abc123',
            transcript_path: '/home/me/.claude/projects/x/abc123.jsonl',
            cwd: '/home/me/code/islet',
            hook_event_name: 'Notification',
            message: 'Claude needs your permission',
            title: 'Permission needed',
            notification_type: 'permission_prompt',
        };
        expect(hookFieldsFromJson(JSON.stringify(input))).toEqual({
            session_id: 'abc123',
            cwd: '/home/me/code/islet',
            hook_event_name: 'Notification',
            notification_type: 'permission_prompt',
        });
    });

    it('never forwards the last assistant message of a Stop', () => {
        const input = {
            session_id: 'abc123',
            cwd: '/home/me/code/islet',
            hook_event_name: 'Stop',
            stop_hook_active: false,
            last_assistant_message: 'secret text',
            background_tasks: [],
        };
        const fields = hookFieldsFromJson(JSON.stringify(input));
        expect(fields).toEqual({session_id: 'abc123', cwd: '/home/me/code/islet', hook_event_name: 'Stop'});
        expect(JSON.stringify(fields)).not.toContain('secret');
    });

    it('drops non-string values', () => {
        expect(hookFieldsFromJson('{"session_id": 42, "cwd": "/x", "hook_event_name": null}')).toEqual({cwd: '/x'});
    });

    it.each(['', 'not json', '[]', 'null', '"text"', '42'])('returns null for %j', text => {
        expect(hookFieldsFromJson(text)).toBeNull();
    });
});
