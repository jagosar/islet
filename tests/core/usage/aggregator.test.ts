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
        const aggregator = new UsageAggregator();
        aggregator.add(record('a'));
        aggregator.add(record('a'));
        aggregator.add(record('a'));
        aggregator.add(record('b'));

        expect(aggregator.size).toBe(2);
        expect(aggregator.bySession().get('s1')?.get('claude-haiku-5-5'))
            .toEqual({input: 2, cacheWrite: 20, cacheRead: 200, output: 2000});
    });

    it('counts a response copied into a resumed session once', () => {
        const aggregator = new UsageAggregator();
        aggregator.add(record('a', {sessionId: 'original'}));
        aggregator.add(record('a', {sessionId: 'resumed'}));

        const days = aggregator.byDay('Europe/Berlin');
        expect(days.get('2026-10-16')?.get('claude-haiku-5-5')?.output).toBe(1000);
    });

    it('keeps models apart', () => {
        const aggregator = new UsageAggregator();
        aggregator.add(record('a', {model: 'claude-haiku-5-5'}));
        aggregator.add(record('b', {model: 'claude-opus-5-5'}));

        const models = aggregator.bySession().get('s1');
        expect([...models?.keys() ?? []].sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    });

    it('groups by local day, not UTC day', () => {
        const aggregator = new UsageAggregator();
        // 23:30 UTC on the 15th is already the 16th in Berlin (UTC+2 in October).
        aggregator.add(record('late', {timestamp: '2026-10-15T23:30:00Z'}));
        aggregator.add(record('noon', {timestamp: '2026-10-16T12:00:00Z'}));

        expect([...aggregator.byDay('Europe/Berlin').keys()]).toEqual(['2026-10-16']);
        expect([...aggregator.byDay('UTC').keys()].sort()).toEqual(['2026-10-15', '2026-10-16']);
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
