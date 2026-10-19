// SPDX-License-Identifier: GPL-2.0-or-later
import {describe, expect, it} from 'vitest';
import {mergePlan, parseDesktopPlanHistory, planFromLimitHit} from '../../src/core/planSources.js';
import type {PlanUsage} from '../../src/core/protocol.js';

const NOW = 1_792_400_000;

describe('parseDesktopPlanHistory', () => {
    const history = (samples: unknown[]) => JSON.stringify({version: 2, samples});

    it('reads the latest sample, by time', () => {
        expect(parseDesktopPlanHistory(history([
            {t: 1_792_363_177_079, org: 'o', u: {fh: 100, sd: 14}},
            {t: 1_792_374_000_393, org: 'o', u: {fh: 0, sd: 14}},
            {t: 1_792_360_000_000, org: 'o', u: {fh: 70, sd: 10}},
        ]))).toEqual({measuredAt: 1_792_374_000, source: 'desktop', fiveHour: {usedPercentage: 0}, sevenDay: {usedPercentage: 14}});
    });

    it('keeps a window that is present and skips one that is not a percentage', () => {
        expect(parseDesktopPlanHistory(history([{t: 1000, u: {fh: 120, sd: 3}}]))).toEqual({measuredAt: 1, source: 'desktop', sevenDay: {usedPercentage: 3}});
    });

    it('skips malformed samples', () => {
        expect(parseDesktopPlanHistory(history([null, 'x', {t: -1, u: {fh: 1}}, {t: 5000, u: null}, {t: 2000, u: {fh: 9}}])))
            .toEqual({measuredAt: 2, source: 'desktop', fiveHour: {usedPercentage: 9}});
    });

    it.each([
        ['invalid JSON', '{'],
        ['no samples', JSON.stringify({version: 2})],
        ['samples that are not a list', JSON.stringify({samples: {}})],
        ['no usable sample', JSON.stringify({samples: [{t: 1, u: {}}]})],
        ['a list', '[]'],
    ])('returns null for %s', (_name, text) => {
        expect(parseDesktopPlanHistory(text)).toBeNull();
    });
});

describe('planFromLimitHit', () => {
    it('puts the session window at 100% until the reset', () => {
        expect(planFromLimitHit({window: 'session', at: NOW - 60, resetsAt: NOW + 3600}, NOW))
            .toEqual({measuredAt: NOW - 60, source: 'limit', fiveHour: {usedPercentage: 100, resetsAt: NOW + 3600}});
    });

    it('puts the weekly window at 100%', () => {
        expect(planFromLimitHit({window: 'weekly', at: NOW, resetsAt: NOW + 1}, NOW)?.sevenDay).toEqual({usedPercentage: 100, resetsAt: NOW + 1});
    });

    it.each([
        ['a reset that has passed', {window: 'session' as const, at: NOW - 9999, resetsAt: NOW}],
        ['no reset', {window: 'session' as const, at: NOW}],
        ['a model-specific limit', {window: 'other' as const, at: NOW, resetsAt: NOW + 60}],
    ])('says nothing for %s', (_name, hit) => {
        expect(planFromLimitHit(hit, NOW)).toBeNull();
    });
});

describe('mergePlan', () => {
    const statusline: PlanUsage = {
        measuredAt: NOW - 600, source: 'statusline',
        fiveHour: {usedPercentage: 40, resetsAt: NOW + 3600}, sevenDay: {usedPercentage: 10, resetsAt: NOW + 86400},
    };

    it('takes the first reading as it is', () => {
        expect(mergePlan(null, statusline, NOW)).toBe(statusline);
    });

    it('ignores a reading older than the current one', () => {
        const older: PlanUsage = {measuredAt: NOW - 900, source: 'desktop', fiveHour: {usedPercentage: 5}};
        expect(mergePlan(statusline, older, NOW)).toBe(statusline);
    });

    it('keeps a known reset time while the desktop reading is the same window', () => {
        const desktop: PlanUsage = {measuredAt: NOW, source: 'desktop', fiveHour: {usedPercentage: 45}, sevenDay: {usedPercentage: 11}};
        expect(mergePlan(statusline, desktop, NOW)).toEqual({
            measuredAt: NOW, source: 'desktop',
            fiveHour: {usedPercentage: 45, resetsAt: NOW + 3600}, sevenDay: {usedPercentage: 11, resetsAt: NOW + 86400},
        });
    });

    it('drops the reset time when the percentage fell: a new window started', () => {
        const desktop: PlanUsage = {measuredAt: NOW, source: 'desktop', fiveHour: {usedPercentage: 2}};
        expect(mergePlan(statusline, desktop, NOW).fiveHour).toEqual({usedPercentage: 2});
    });

    it('drops the reset time once it has passed', () => {
        const desktop: PlanUsage = {measuredAt: NOW + 7200, source: 'desktop', fiveHour: {usedPercentage: 50}};
        expect(mergePlan(statusline, desktop, NOW + 7200).fiveHour).toEqual({usedPercentage: 50});
    });

    it('keeps the other window when a limit message names one', () => {
        const desktop: PlanUsage = {measuredAt: NOW - 60, source: 'desktop', fiveHour: {usedPercentage: 91}, sevenDay: {usedPercentage: 63}};
        const limit = planFromLimitHit({window: 'session', at: NOW, resetsAt: NOW + 3000}, NOW)!;
        expect(mergePlan(desktop, limit, NOW)).toEqual({
            measuredAt: NOW, source: 'limit',
            fiveHour: {usedPercentage: 100, resetsAt: NOW + 3000}, sevenDay: {usedPercentage: 63},
        });
    });

    it('forgets a window that is missing from the reading and known to have reset', () => {
        const limit: PlanUsage = {measuredAt: NOW + 90_000, source: 'limit', fiveHour: {usedPercentage: 100, resetsAt: NOW + 99_000}};
        expect(mergePlan(statusline, limit, NOW + 90_000).sevenDay).toBeUndefined();
    });
});
