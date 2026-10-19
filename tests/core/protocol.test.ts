import {describe, expect, it} from 'vitest';
import {
    decodeInsights, decodePlanEstimate, decodePlanUsage, decodeSessions, decodeUsage, encodeInsights, encodePlanEstimate,
    encodePlanUsage, encodeSessions, encodeUsage,
    parsePlanUsageReport, type AgentSession, type PlanUsage, type UsageSnapshot,
} from '../../src/core/protocol.js';
import type {Insights} from '../../src/core/usage/insights.js';

const plan: PlanUsage = {
    measuredAt: 1_792_150_000,
    fiveHour: {usedPercentage: 33, resetsAt: 1_792_160_000},
    sevenDay: {usedPercentage: 4, resetsAt: 1_792_600_000},
};

describe('plan usage document', () => {
    it('round-trips', () => {
        expect(decodePlanUsage(encodePlanUsage(plan))).toEqual(plan);
    });

    it('round-trips a single window', () => {
        const fiveHourOnly = {measuredAt: 1, fiveHour: {usedPercentage: 50, resetsAt: 2}};
        expect(decodePlanUsage(encodePlanUsage(fiveHourOnly))).toEqual(fiveHourOnly);
    });

    it('encodes "no plan usage" as null and decodes it to null', () => {
        expect(decodePlanUsage(encodePlanUsage(null))).toBeNull();
    });

    it.each([
        ['not JSON', 'nope'],
        ['another version', JSON.stringify({version: 2, plan})],
        ['a percentage over 100', JSON.stringify({version: 1, plan: {...plan, fiveHour: {usedPercentage: 101, resetsAt: 1}}})],
        ['no window', JSON.stringify({version: 1, plan: {measuredAt: 1}})],
        ['no measuredAt', JSON.stringify({version: 1, plan: {fiveHour: plan.fiveHour}})],
    ])('rejects %s', (_name, text) => {
        expect(decodePlanUsage(text)).toBeNull();
    });
});

describe('parsePlanUsageReport', () => {
    it('reads both windows and stamps the time', () => {
        expect(parsePlanUsageReport({
            five_hour_used_percentage: 33, five_hour_resets_at: 1_792_160_000,
            seven_day_used_percentage: 4, seven_day_resets_at: 1_792_600_000,
        }, 1_792_150_000)).toEqual({...plan, source: 'statusline'});
    });

    it('skips a window with a missing half', () => {
        expect(parsePlanUsageReport({five_hour_used_percentage: 10, seven_day_used_percentage: 4, seven_day_resets_at: 9}, 1))
            .toEqual({measuredAt: 1, source: 'statusline', sevenDay: {usedPercentage: 4, resetsAt: 9}});
    });

    it.each([
        ['nothing', {}],
        ['a negative percentage', {five_hour_used_percentage: -1, five_hour_resets_at: 9}],
        ['a percentage over 100', {five_hour_used_percentage: 100.5, five_hour_resets_at: 9}],
        ['a non-finite reset', {five_hour_used_percentage: 5, five_hour_resets_at: Number.POSITIVE_INFINITY}],
    ])('returns null for %s', (_name, fields) => {
        expect(parsePlanUsageReport(fields, 1)).toBeNull();
    });
});

describe('usage document', () => {
    const usage: UsageSnapshot = {
        today: {day: '2026-10-16', models: {'claude-opus-5-5': {input: 1, cacheWrite: 2, cacheRead: 3, output: 4}}},
        history: [{day: '2026-10-15', fresh: 10}, {day: '2026-10-16', fresh: 7}],
    };

    it('round-trips', () => {
        expect(decodeUsage(encodeUsage(usage))).toEqual(usage);
    });

    it('round-trips an empty snapshot', () => {
        expect(decodeUsage(encodeUsage({today: null, history: []}))).toEqual({today: null, history: []});
    });

    it.each([
        ['a bad day', {today: {day: '16/10/2026', models: {}}, history: []}],
        ['negative tokens', {today: {day: '2026-10-16', models: {m: {input: -1, cacheWrite: 0, cacheRead: 0, output: 0}}}, history: []}],
        ['missing token fields', {today: {day: '2026-10-16', models: {m: {input: 1}}}, history: []}],
        ['a bad history entry', {today: null, history: [{day: '2026-10-16'}]}],
    ])('rejects %s', (_name, bad) => {
        expect(decodeUsage(JSON.stringify({version: 1, usage: bad}))).toBeNull();
    });
});

describe('sessions document', () => {
    const sessions: AgentSession[] = [
        {sessionId: 'a', project: 'islet', state: 'needs-permission', since: 5},
        {sessionId: 'b', project: 'other', state: 'working', since: 6},
    ];

    it('round-trips', () => {
        expect(decodeSessions(encodeSessions(sessions))).toEqual(sessions);
    });

    it('rejects an unknown state', () => {
        expect(decodeSessions(JSON.stringify({version: 1, sessions: [{...sessions[0], state: 'sleeping'}]}))).toBeNull();
    });
});

describe('plan windows without a reset time', () => {
    it('round-trips a desktop reading', () => {
        const desktop: PlanUsage = {measuredAt: 5, source: 'desktop', fiveHour: {usedPercentage: 45}, sevenDay: {usedPercentage: 20}};
        expect(decodePlanUsage(encodePlanUsage(desktop))).toEqual(desktop);
    });

    it.each([
        ['an unknown source', {measuredAt: 5, source: 'cloud', fiveHour: {usedPercentage: 1}}],
        ['a reset time that is not a count', {measuredAt: 5, fiveHour: {usedPercentage: 1, resetsAt: 'soon'}}],
    ])('rejects %s', (_name, document) => {
        expect(decodePlanUsage(JSON.stringify({version: 1, plan: document}))).toBeNull();
    });
});

describe('insights document', () => {
    const insights: Insights = {
        generatedAt: 100,
        day: {requests: 3, estimatedUsd: 2.5, attribution: [{kind: 'mcp', name: 'ccd_turn', share: 0.15}], flags: [{id: 'long-context', share: 0.79}]},
        week: {requests: 0, estimatedUsd: 0, attribution: [], flags: []},
        session: {
            sessionId: 's', project: 'islet', startedAt: 1, lastAt: 2, activeSeconds: 60, requests: 3, usd: 86.5, exact: true,
            cacheHitRatio: 0.99, apiSeconds: 8280, linesAdded: 9226, linesRemoved: 98,
            models: [{model: 'claude-opus-5-5', tokens: {input: 1, cacheWrite: 2, cacheRead: 3, output: 4}, share: 1, usd: 86.5}],
        },
    };

    it('round-trips', () => {
        expect(decodeInsights(encodeInsights(insights))).toEqual(insights);
        expect(decodeInsights(encodeInsights({...insights, session: null}))?.session).toBeNull();
    });

    it('decodes "no data yet" as null', () => {
        expect(decodeInsights(encodeInsights(null))).toBeNull();
    });

    const broken = (patch: (copy: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const copy = JSON.parse(JSON.stringify(insights)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        patch(copy);
        return JSON.stringify({version: 1, insights: copy});
    };

    it.each([
        ['an unknown attribution kind', (c: Record<string, any>) => { c.day.attribution[0].kind = 'tool'; }], // eslint-disable-line @typescript-eslint/no-explicit-any
        ['a share over 1', (c: Record<string, any>) => { c.day.flags[0].share = 1.5; }], // eslint-disable-line @typescript-eslint/no-explicit-any
        ['an unknown flag', (c: Record<string, any>) => { c.week.flags = [{id: 'nope', share: 0.5}]; }], // eslint-disable-line @typescript-eslint/no-explicit-any
        ['a negative cost', (c: Record<string, any>) => { c.session.usd = -1; }], // eslint-disable-line @typescript-eslint/no-explicit-any
        ['bad model tokens', (c: Record<string, any>) => { c.session.models[0].tokens.input = 'x'; }], // eslint-disable-line @typescript-eslint/no-explicit-any
        ['a bad optional count', (c: Record<string, any>) => { c.session.linesAdded = -3; }], // eslint-disable-line @typescript-eslint/no-explicit-any
        ['a missing window', (c: Record<string, any>) => { delete c.week; }], // eslint-disable-line @typescript-eslint/no-explicit-any
    ])('rejects %s', (_name, patch) => {
        expect(decodeInsights(broken(patch))).toBeNull();
    });

    it('rejects another protocol version', () => {
        expect(decodeInsights(JSON.stringify({version: 2, insights}))).toBeNull();
    });
});

describe('plan estimate document', () => {
    const estimate = {fiveHour: 33.4, basedOn: 1_792_394_040, at: 1_792_394_300};

    it('round-trips, and null means no estimate', () => {
        expect(decodePlanEstimate(encodePlanEstimate(estimate))).toEqual(estimate);
        expect(decodePlanEstimate(encodePlanEstimate(null))).toBeNull();
    });

    it.each([
        ['a figure over 100', {...estimate, fiveHour: 101}],
        ['a negative figure', {...estimate, fiveHour: -1}],
        ['a missing reading', {fiveHour: 33, at: 5}],
        ['a time that is not a count', {...estimate, at: 'now'}],
    ])('rejects %s', (_name, document) => {
        expect(decodePlanEstimate(JSON.stringify({version: 1, estimate: document}))).toBeNull();
    });

    it('rejects another protocol version', () => {
        expect(decodePlanEstimate(JSON.stringify({version: 2, estimate}))).toBeNull();
    });
});
