import {describe, expect, it} from 'vitest';
import {
    decodePlanUsage, decodeSessions, decodeUsage, encodePlanUsage, encodeSessions, encodeUsage,
    parsePlanUsageReport, type AgentSession, type PlanUsage, type UsageSnapshot,
} from '../../src/core/protocol.js';

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
        }, 1_792_150_000)).toEqual(plan);
    });

    it('skips a window with a missing half', () => {
        expect(parsePlanUsageReport({five_hour_used_percentage: 10, seven_day_used_percentage: 4, seven_day_resets_at: 9}, 1))
            .toEqual({measuredAt: 1, sevenDay: {usedPercentage: 4, resetsAt: 9}});
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
