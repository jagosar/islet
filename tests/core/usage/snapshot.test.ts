import {describe, expect, it} from 'vitest';
import type {ModelTotals} from '../../../src/core/usage/aggregator.js';
import {HISTORY_DAYS, buildUsageSnapshot, daysBefore} from '../../../src/core/usage/snapshot.js';

function models(fresh: number): ModelTotals {
    return new Map([['m', {input: fresh, cacheWrite: 0, cacheRead: 999, output: 0}]]);
}

describe('daysBefore', () => {
    it.each([
        ['2026-10-16', 0, '2026-10-16'],
        ['2026-10-16', 16, '2026-09-30'],
        ['2026-03-01', 1, '2026-02-28'],
        ['2028-03-01', 1, '2028-02-29'],
        ['2026-01-01', 1, '2025-12-31'],
    ])('%s minus %d is %s', (day, days, expected) => {
        expect(daysBefore(day, days)).toBe(expected);
    });
});

describe('buildUsageSnapshot', () => {
    it('has today per model and fresh history, oldest first', () => {
        const days = new Map([['2026-10-16', models(7)], ['2026-10-14', models(3)]]);
        expect(buildUsageSnapshot(days, '2026-10-16')).toEqual({
            today: {day: '2026-10-16', models: {m: {input: 7, cacheWrite: 0, cacheRead: 999, output: 0}}},
            history: [{day: '2026-10-14', fresh: 3}, {day: '2026-10-16', fresh: 7}],
        });
    });

    it('keeps only the last 26 weeks and nothing after today', () => {
        const first = daysBefore('2026-10-16', HISTORY_DAYS - 1);
        const days = new Map([
            [daysBefore(first, 1), models(1)],
            [first, models(2)],
            ['2026-10-17', models(3)],
        ]);
        expect(buildUsageSnapshot(days, '2026-10-16').history).toEqual([{day: first, fresh: 2}]);
    });

    it('has no today without usage today, and skips days with only cache reads', () => {
        const days = new Map([['2026-10-15', models(0)]]);
        expect(buildUsageSnapshot(days, '2026-10-16')).toEqual({today: null, history: []});
    });
});
