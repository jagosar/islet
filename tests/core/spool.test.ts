// SPDX-License-Identifier: GPL-2.0-or-later
import {describe, expect, it} from 'vitest';
import {
    MAX_SPOOL_ENTRIES, PLAN_SPOOL_FILE, SPOOL_MAX_AGE_S, decodeSpoolEntry, encodeSpoolEntry, isSpoolFileName, selectSpoolEntries, spoolFileName,
} from '../../src/core/spool.js';

const event = {kind: 'agent-event', at: 1000, fields: {session_id: 's', cwd: '/x', hook_event_name: 'Stop'}} as const;
const plan = {kind: 'plan-usage', at: 1000, fields: {five_hour_used_percentage: 33, five_hour_resets_at: 9999}} as const;

describe('spool entries', () => {
    it.each([event, plan])('round-trip: $kind', entry => {
        expect(decodeSpoolEntry(encodeSpoolEntry(entry))).toEqual(entry);
    });

    it.each([
        ['not JSON', 'nope'],
        ['an unknown kind', JSON.stringify({kind: 'shell', at: 1, fields: {}})],
        ['a missing time', JSON.stringify({kind: 'agent-event', fields: {}})],
        ['a negative time', JSON.stringify({kind: 'agent-event', at: -1, fields: {}})],
        ['non-string event fields', JSON.stringify({kind: 'agent-event', at: 1, fields: {a: 1}})],
        ['non-numeric plan fields', JSON.stringify({kind: 'plan-usage', at: 1, fields: {a: 'x'}})],
        ['too many fields', JSON.stringify({kind: 'agent-event', at: 1, fields: Object.fromEntries(Array.from({length: 17}, (_, i) => [`k${i}`, 'v']))})],
        ['an array', '[]'],
    ])('rejects %s', (_name, text) => {
        expect(decodeSpoolEntry(text)).toBeNull();
    });

    it('names files so that they sort in the order events happened', () => {
        const names = [spoolFileName(1000.5, 1, 'agent-event'), spoolFileName(1000.5, 2, 'agent-event'), spoolFileName(999, 9, 'agent-event'), spoolFileName(2000, 0, 'agent-event')];
        expect([...names].sort()).toEqual([names[2], names[0], names[1], names[3]]);
        expect(isSpoolFileName(names[0])).toBe(true);
    });

    it('recognises only its own files', () => {
        expect(isSpoolFileName(PLAN_SPOOL_FILE)).toBe(true);
        for (const foreign of ['readme.txt', 'notes.json', '123-1-agent-event.json', '000000000001000-000001-other.json', '.hidden'])
            expect(isSpoolFileName(foreign), foreign).toBe(false);
    });
});

describe('selectSpoolEntries', () => {
    const now = 100_000;
    const e = (at: number, extra = 0) => ({name: spoolFileName(at, extra, 'agent-event'), entry: {...event, at}});

    it('keeps entries in order and drops the stale ones', () => {
        const result = selectSpoolEntries([e(now - 10, 1), e(now - SPOOL_MAX_AGE_S - 1), e(now - 20, 2)], now);
        expect(result.use.map(x => x.entry.at)).toEqual([now - 20, now - 10]);
        expect(result.discard).toHaveLength(1);
    });

    it('drops the oldest beyond the cap', () => {
        const many = Array.from({length: MAX_SPOOL_ENTRIES + 5}, (_, i) => e(now - 5000 + i, i));
        const result = selectSpoolEntries(many, now);
        expect(result.use).toHaveLength(MAX_SPOOL_ENTRIES);
        expect(result.discard).toHaveLength(5);
        expect(result.use[0].entry.at).toBe(now - 5000 + 5);
    });

    it('ignores entries from the future beyond a small clock skew', () => {
        expect(selectSpoolEntries([e(now + 3600)], now).discard).toHaveLength(1);
        expect(selectSpoolEntries([e(now + 5)], now).use).toHaveLength(1);
    });
});
