// SPDX-License-Identifier: GPL-2.0-or-later
import {describe, expect, it} from 'vitest';
import type {Attribution, CostState, TokenCounts, UsageRecord} from '../../../src/core/usage/claudeTranscript.js';
import {
    DAY_SECONDS, InsightsCollector, WEEK_SECONDS, contextTokens, requestWeight,
} from '../../../src/core/usage/insights.js';

const NOW = 1_792_400_000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

let counter = 0;
function record(at: number, options: {
    session?: string; model?: string; tokens?: Partial<TokenCounts>; sidechain?: boolean; attribution?: Attribution; project?: string;
} = {}): UsageRecord {
    counter++;
    return {
        messageId: `m${counter}`,
        sessionId: options.session ?? 's1',
        model: options.model ?? 'claude-sonnet-5-5',
        timestamp: iso(at),
        tokens: {input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ...options.tokens},
        sidechain: options.sidechain ?? false,
        attribution: options.attribution ?? {},
        ...(options.project ? {project: options.project} : {}),
    };
}

function collector(records: UsageRecord[]): InsightsCollector {
    const c = new InsightsCollector(() => NOW);
    records.forEach(r => c.add(r));
    return c;
}

/** A plain request worth exactly $1 at Sonnet prices ($3 per million input tokens, x5 for output). */
const ONE_DOLLAR = {output: 200_000 / 3};

describe('requestWeight', () => {
    it('prices each token type relative to input, by model family', () => {
        const tokens = {input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000, output: 1_000_000};
        expect(requestWeight('claude-sonnet-5-5', tokens)).toBeCloseTo(3 * (1 + 1.25 + 0.1 + 5));
        expect(requestWeight('claude-opus-5-5', tokens)).toBeCloseTo(5 * 7.35);
        expect(requestWeight('claude-haiku-5-5', tokens)).toBeCloseTo(7.35);
        expect(requestWeight('some-other-model', tokens)).toBeCloseTo(3 * 7.35);
    });

    it('counts all input-side tokens as context', () => {
        expect(contextTokens({input: 1, cacheWrite: 2, cacheRead: 3, output: 100})).toBe(6);
    });
});

describe('breakdown windows', () => {
    it('attributes shares by kind and name, overlapping, sorted, and drops rows under 1%', () => {
        const insights = collector([
            record(NOW - 100, {tokens: ONE_DOLLAR, attribution: {mcpServer: 'ccd_turn', skill: 'architect'}}),
            record(NOW - 90, {tokens: ONE_DOLLAR, attribution: {agent: 'implementer'}}),
            record(NOW - 80, {tokens: ONE_DOLLAR}),
            record(NOW - 70, {tokens: {output: ONE_DOLLAR.output / 200}, attribution: {plugin: 'tiny'}}),
        ]).build(NOW);
        expect(insights.day.requests).toBe(4);
        expect(insights.day.estimatedUsd).toBeCloseTo(3.005);
        expect(insights.day.attribution.map(a => [a.kind, a.name])).toEqual([
            ['skill', 'architect'], ['mcp', 'ccd_turn'], ['agent', 'implementer'],
        ]);
        expect(insights.day.attribution[0].share).toBeCloseTo(1 / 3.005);
    });

    it('keeps at most six attribution rows', () => {
        const many = Array.from({length: 9}, (_, i) => record(NOW - 10 - i, {tokens: ONE_DOLLAR, attribution: {skill: `s${i}`}}));
        expect(collector(many).build(NOW).day.attribution).toHaveLength(6);
    });

    it('separates the last 24 hours from the last 7 days', () => {
        const insights = collector([
            record(NOW - 2 * DAY_SECONDS, {tokens: ONE_DOLLAR, attribution: {skill: 'old'}}),
            record(NOW - 60, {tokens: ONE_DOLLAR, attribution: {skill: 'new'}}),
        ]).build(NOW);
        expect(insights.day.attribution.map(a => a.name)).toEqual(['new']);
        expect(insights.week.attribution.map(a => a.name).sort()).toEqual(['new', 'old']);
    });

    it('flags long context above 150k tokens', () => {
        const insights = collector([
            record(NOW - 60, {tokens: {cacheRead: 150_001, ...ONE_DOLLAR}}),
            record(NOW - 50, {session: 's2', tokens: {cacheRead: 150_000, ...ONE_DOLLAR}}),
        ]).build(NOW);
        const flag = insights.day.flags.find(f => f.id === 'long-context');
        expect(flag?.share).toBeCloseTo(0.5, 1);
    });

    it('flags requests from sessions that started more than 8 hours earlier, also before the window', () => {
        const insights = collector([
            record(NOW - 2 * DAY_SECONDS, {tokens: {output: 1}}), // s1 starts two days ago.
            record(NOW - 60, {tokens: ONE_DOLLAR}),
            record(NOW - 50, {session: 'fresh', tokens: ONE_DOLLAR}),
        ]).build(NOW);
        expect(insights.day.flags.find(f => f.id === 'long-session')?.share).toBeCloseTo(0.5);
    });

    it('flags requests made while four or more sessions were active in the last 10 minutes', () => {
        const base = NOW - 3600;
        const records = [
            record(base, {session: 'a', tokens: ONE_DOLLAR}),
            record(base + 60, {session: 'b', tokens: ONE_DOLLAR}),
            record(base + 120, {session: 'c', tokens: ONE_DOLLAR}),
            record(base + 180, {session: 'd', tokens: ONE_DOLLAR}), // Fourth active: parallel.
            record(base + 180 + 11 * 60, {session: 'e', tokens: ONE_DOLLAR}), // The others went quiet.
        ];
        expect(collector(records).build(NOW).day.flags.find(f => f.id === 'parallel')?.share).toBeCloseTo(0.2);
    });

    it('estimates always-on context as the first context of the session, read from cache each time', () => {
        const insights = collector([
            record(NOW - 100, {tokens: {cacheWrite: 30_000}}),
            record(NOW - 90, {tokens: {cacheRead: 30_000, cacheWrite: 1_000}}),
        ]).build(NOW);
        const total = requestWeight('claude-sonnet-5-5', {input: 0, cacheWrite: 31_000, cacheRead: 30_000, output: 0});
        const always = 2 * 30_000 * 0.1 * 3 / 1_000_000;
        expect(insights.day.flags.find(f => f.id === 'always-on-context')?.share).toBeCloseTo(always / total);
    });

    it('flags a cache miss: a later request that writes most of a large context again', () => {
        const insights = collector([
            record(NOW - 100, {tokens: {cacheWrite: 50_000}}),
            record(NOW - 90, {tokens: {cacheRead: 50_000, output: 10}}),
            record(NOW - 80, {tokens: {cacheWrite: 50_000}}), // Re-written: the cache expired.
        ]).build(NOW);
        expect(insights.day.flags.map(f => f.id)).toContain('cache-miss');
    });

    it('shows only behaviours that reach 10%', () => {
        const insights = collector([
            record(NOW - 60, {tokens: {cacheRead: 200_000, output: 1}}),
            record(NOW - 50, {session: 's2', tokens: {output: 1_000_000}}),
        ]).build(NOW);
        expect(insights.day.flags.map(f => f.id)).not.toContain('long-context');
    });

    it('is empty without requests', () => {
        expect(collector([]).build(NOW)).toEqual({
            generatedAt: NOW,
            day: {requests: 0, estimatedUsd: 0, attribution: [], flags: []},
            week: {requests: 0, estimatedUsd: 0, attribution: [], flags: []},
            session: null,
        });
    });
});

describe('the current session', () => {
    const costState = (session: string, models: [string, TokenCounts, number][], extra: Partial<CostState> = {}): CostState => ({
        sessionId: session,
        models: new Map(models.map(([m, t]) => [m, t])),
        modelCostUsd: new Map(models.map(([m, , usd]) => [m, usd])),
        ...extra,
    });

    it('is the session of the latest main-thread response, with its subagents', () => {
        const insights = collector([
            record(NOW - 300, {session: 'main', project: 'islet', tokens: ONE_DOLLAR}),
            record(NOW - 200, {session: 'main', sidechain: true, model: 'claude-haiku-5-5', tokens: {output: 100}}),
            record(NOW - 100, {session: 'other', sidechain: true, tokens: ONE_DOLLAR}),
        ]).build(NOW);
        expect(insights.session).toMatchObject({sessionId: 'main', project: 'islet', requests: 2, exact: false});
        expect(insights.session?.models.map(m => m.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5']);
        expect(insights.session?.usd).toBeCloseTo(1 + requestWeight('claude-haiku-5-5', {input: 0, cacheWrite: 0, cacheRead: 0, output: 100}));
    });

    it('counts active time only across gaps of up to 5 minutes', () => {
        const insights = collector([
            record(NOW - 3000), record(NOW - 2880), // 2 min
            record(NOW - 600), record(NOW - 360), // 4 min (the 38-minute gap before is idle)
        ]).build(NOW);
        expect(insights.session?.activeSeconds).toBe(120 + 240);
    });

    it('measures cache hits over all input-side tokens', () => {
        const insights = collector([record(NOW - 10, {tokens: {input: 10, cacheWrite: 90, cacheRead: 900}})]).build(NOW);
        expect(insights.session?.cacheHitRatio).toBeCloseTo(0.9);
    });

    it("uses Claude Code's own totals once they cover the session", () => {
        const c = collector([record(NOW - 10, {tokens: {output: 100}})]);
        c.setCostState(costState('s1', [['claude-sonnet-5-5', {input: 5, cacheWrite: 0, cacheRead: 0, output: 120}, 86.5]], {
            totalCostUsd: 86.5, apiDurationMs: 8_280_000, linesAdded: 9226, linesRemoved: 98,
        }));
        expect(c.build(NOW).session).toMatchObject({
            exact: true, usd: 86.5, apiSeconds: 8280, linesAdded: 9226, linesRemoved: 98,
            models: [{model: 'claude-sonnet-5-5', usd: 86.5, share: 1, tokens: {input: 5, cacheWrite: 0, cacheRead: 0, output: 120}}],
        });
    });

    it('estimates again when a resumed session goes past those totals', () => {
        const c = collector([record(NOW - 10, {tokens: {output: 500}})]);
        c.setCostState(costState('s1', [['claude-sonnet-5-5', {input: 0, cacheWrite: 0, cacheRead: 0, output: 100}, 1]], {totalCostUsd: 1}));
        const session = c.build(NOW).session;
        expect(session?.exact).toBe(false);
        expect(session?.apiSeconds).toBeUndefined();
    });

    it('estimates when a model of the session is missing from the totals', () => {
        const c = collector([record(NOW - 20, {tokens: {output: 1}}), record(NOW - 10, {model: 'claude-opus-5-5', tokens: {output: 1}})]);
        c.setCostState(costState('s1', [['claude-sonnet-5-5', {input: 0, cacheWrite: 0, cacheRead: 0, output: 10}, 1]]));
        expect(c.build(NOW).session?.exact).toBe(false);
    });
});

describe('memory bounds', () => {
    it('does not keep responses older than a week and a day', () => {
        const c = collector([record(NOW - WEEK_SECONDS - DAY_SECONDS - 1), record(NOW - 10)]);
        expect(c.size).toBe(1);
    });

    it('prunes responses that leave the week, and the totals of sessions with none left', () => {
        const c = collector([record(NOW - WEEK_SECONDS + 10, {session: 'old'}), record(NOW - 10, {session: 'new'})]);
        c.setCostState({sessionId: 'old', models: new Map(), modelCostUsd: new Map()});
        c.prune(NOW + 20);
        expect(c.size).toBe(1);
        expect(c.build(NOW + 20).week.requests).toBe(1);
    });

    it('accepts responses out of order', () => {
        const c = collector([record(NOW - 10, {session: 'late'}), record(NOW - 500, {session: 'early', sidechain: false})]);
        expect(c.build(NOW).session?.sessionId).toBe('late');
    });

    it('skips a record with an unreadable time', () => {
        const c = new InsightsCollector(() => NOW);
        c.add({...record(NOW), timestamp: 'not a date'});
        expect(c.size).toBe(0);
    });
});

describe('weightBetween', () => {
    it('adds up what was consumed after the start and up to the end', () => {
        const c = collector([
            record(NOW - 500, {tokens: ONE_DOLLAR}),
            record(NOW - 400, {tokens: ONE_DOLLAR}),
            record(NOW - 300, {tokens: ONE_DOLLAR}),
            record(NOW - 200, {tokens: ONE_DOLLAR}),
        ]);
        expect(c.weightBetween(NOW - 450, NOW - 250)).toBeCloseTo(2);   // the 400 and 300 ones
        expect(c.weightBetween(NOW - 400, NOW - 300)).toBeCloseTo(1);   // from exclusive, to inclusive
        expect(c.weightBetween(NOW - 600, NOW)).toBeCloseTo(4);
        expect(c.weightBetween(NOW - 100, NOW)).toBe(0);
        expect(c.weightBetween(NOW - 600, NOW - 550)).toBe(0);
    });

    it('counts a response exactly at the end, and not one exactly at the start', () => {
        const c = collector([record(NOW - 400, {tokens: ONE_DOLLAR}), record(NOW - 300, {tokens: ONE_DOLLAR})]);
        expect(c.weightBetween(NOW - 450, NOW - 300)).toBeCloseTo(2);     // end at the later one: included
        expect(c.weightBetween(NOW - 400, NOW - 250)).toBeCloseTo(1);     // start at the earlier one: excluded
    });

    it('is 0 for an empty or backwards range', () => {
        expect(collector([]).weightBetween(0, NOW)).toBe(0);
        const c = collector([record(NOW - 100, {tokens: ONE_DOLLAR})]);
        expect(c.weightBetween(NOW, NOW - 200)).toBe(0);
    });

    it('prices each model by its family', () => {
        const c = collector([
            record(NOW - 100, {model: 'claude-opus-5-5', tokens: ONE_DOLLAR}),
            record(NOW - 90, {model: 'claude-haiku-5-5', tokens: ONE_DOLLAR}),
        ]);
        expect(c.weightBetween(NOW - 200, NOW)).toBeCloseTo(5 / 3 + 1 / 3);
    });

    it('follows additions, late (out of order) responses and pruning', () => {
        const c = collector([record(NOW - 100, {tokens: ONE_DOLLAR})]);
        expect(c.weightBetween(NOW - 300, NOW)).toBeCloseTo(1);
        c.add(record(NOW - 50, {tokens: ONE_DOLLAR}));
        expect(c.weightBetween(NOW - 300, NOW)).toBeCloseTo(2);
        c.add(record(NOW - 200, {tokens: ONE_DOLLAR}));             // written late, but it happened earlier
        expect(c.weightBetween(NOW - 300, NOW)).toBeCloseTo(3);
        expect(c.weightBetween(NOW - 250, NOW - 150)).toBeCloseTo(1);
        c.prune(NOW + WEEK_SECONDS - 120);                          // only the last two stay in the week
        expect(c.weightBetween(NOW - 300, NOW)).toBeCloseTo(2);
    });
});
