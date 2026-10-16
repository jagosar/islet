import {describe, expect, it} from 'vitest';
import {UsageAggregator, dayKey} from '../../../src/core/usage/aggregator.js';
import type {UsageRecord} from '../../../src/core/usage/claudeTranscript.js';

function record(messageId: string, overrides: Partial<UsageRecord> = {}): UsageRecord {
    return {
        messageId,
        sessionId: 's1',
        model: 'claude-haiku-5-5',
        timestamp: '2026-10-16T10:00:00Z',
        tokens: {input: 1, cacheWrite: 10, cacheRead: 100, output: 1000},
        ...overrides,
    };
}

describe('UsageAggregator', () => {
    it('counts a response repeated on several lines once', () => {
        const aggregator = new UsageAggregator('Europe/Berlin');
        expect(aggregator.add(record('a'))).toBe(true);
        expect(aggregator.add(record('a'))).toBe(false);
        expect(aggregator.add(record('a'))).toBe(false);
        aggregator.add(record('b'));

        expect(aggregator.size).toBe(2);
        expect(aggregator.bySession().get('s1')?.get('claude-haiku-5-5'))
            .toEqual({input: 2, cacheWrite: 20, cacheRead: 200, output: 2000});
    });

    it('counts a response copied into a resumed session once, for the original session', () => {
        const aggregator = new UsageAggregator('Europe/Berlin');
        aggregator.add(record('a', {sessionId: 'original'}));
        aggregator.add(record('a', {sessionId: 'resumed'}));

        expect(aggregator.byDay().get('2026-10-16')?.get('claude-haiku-5-5')?.output).toBe(1000);
        expect([...aggregator.bySession().keys()]).toEqual(['original']);
    });

    it('keeps models apart', () => {
        const aggregator = new UsageAggregator('Europe/Berlin');
        aggregator.add(record('a', {model: 'claude-haiku-5-5'}));
        aggregator.add(record('b', {model: 'claude-opus-5-5'}));

        expect([...aggregator.bySession().get('s1')?.keys() ?? []].sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    });

    it('groups by local day, not UTC day', () => {
        const berlin = new UsageAggregator('Europe/Berlin');
        const utc = new UsageAggregator('UTC');
        for (const aggregator of [berlin, utc]) {
            // 23:30 UTC on the 15th is already the 16th in Berlin (UTC+2 in October).
            aggregator.add(record('late', {timestamp: '2026-10-15T23:30:00Z'}));
            aggregator.add(record('noon', {timestamp: '2026-10-16T12:00:00Z'}));
        }
        expect([...berlin.byDay().keys()]).toEqual(['2026-10-16']);
        expect([...utc.byDay().keys()].sort()).toEqual(['2026-10-15', '2026-10-16']);
    });

    it('does not let queries change its totals', () => {
        const aggregator = new UsageAggregator('UTC');
        aggregator.add(record('a'));
        aggregator.byDay().get('2026-10-16')!.get('claude-haiku-5-5')!.output = 0;
        expect(aggregator.byDay().get('2026-10-16')?.get('claude-haiku-5-5')?.output).toBe(1000);
    });

    describe('session references (cost-state)', () => {
        it('books the calls missing from the transcript on the session\'s last day', () => {
            const aggregator = new UsageAggregator('UTC');
            aggregator.add(record('a', {timestamp: '2026-10-15T10:00:00Z'}));
            aggregator.add(record('b', {timestamp: '2026-10-16T10:00:00Z'}));
            aggregator.setSessionReference('s1', new Map([
                ['claude-haiku-5-5', {input: 5, cacheWrite: 20, cacheRead: 600, output: 2000}],
                ['claude-haiku-4-5', {input: 900, cacheWrite: 0, cacheRead: 0, output: 14}],
            ]));

            const days = aggregator.byDay();
            expect(days.get('2026-10-15')?.get('claude-haiku-5-5')).toEqual({input: 1, cacheWrite: 10, cacheRead: 100, output: 1000});
            expect(days.get('2026-10-16')?.get('claude-haiku-5-5')).toEqual({input: 4, cacheWrite: 10, cacheRead: 500, output: 1000});
            expect(days.get('2026-10-16')?.get('claude-haiku-4-5')).toEqual({input: 900, cacheWrite: 0, cacheRead: 0, output: 14});
        });

        it('never subtracts when the reference is lower than the transcript', () => {
            const aggregator = new UsageAggregator('UTC');
            aggregator.add(record('a'));
            aggregator.setSessionReference('s1', new Map([['claude-haiku-5-5', {input: 0, cacheWrite: 0, cacheRead: 0, output: 0}]]));
            expect(aggregator.byDay().get('2026-10-16')?.get('claude-haiku-5-5')?.output).toBe(1000);
        });

        it('ignores a reference for a session without records', () => {
            const aggregator = new UsageAggregator('UTC');
            aggregator.setSessionReference('ghost', new Map([['m', {input: 1, cacheWrite: 1, cacheRead: 1, output: 1}]]));
            expect(aggregator.byDay().size).toBe(0);
        });
    });
});

describe('dayKey', () => {
    it.each([
        ['2026-10-16T10:00:00Z', 'Europe/Berlin', '2026-10-16'],
        ['2026-10-15T22:30:00Z', 'Europe/Berlin', '2026-10-16'],
        ['2026-10-16T03:00:00Z', 'America/New_York', '2026-10-15'],
    ])('%s in %s is %s', (timestamp, timeZone, expected) => {
        expect(dayKey(timestamp, timeZone)).toBe(expected);
    });
});
