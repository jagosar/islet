import {describe, expect, it} from 'vitest';
import {formatAgo, formatDuration, sessionStateLabel} from '../../src/core/panel.js';

describe('formatAgo', () => {
    it.each([
        [0, 'just now'], [59, 'just now'], [60, '1 min ago'], [3599, '59 min ago'],
        [3600, '1 h ago'], [86399, '23 h ago'], [86400, '1 day ago'], [3 * 86400, '3 days ago'],
    ])('%d s -> %s', (seconds, expected) => {
        expect(formatAgo(seconds)).toBe(expected);
    });
});

describe('formatDuration', () => {
    it.each([[30, '<1 min'], [300, '5 min'], [3600, '1 h'], [3600 + 1200, '1 h 20 min']])('%d s -> %s', (seconds, expected) => {
        expect(formatDuration(seconds)).toBe(expected);
    });
});

describe('sessionStateLabel', () => {
    it('labels every state', () => {
        expect(['needs-permission', 'waiting', 'working', 'finished', 'idle'].map(s => sessionStateLabel(s as never)))
            .toEqual(['needs permission', 'waiting for you', 'working', 'finished', 'idle']);
    });
});
