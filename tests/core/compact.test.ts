import {describe, expect, it} from 'vitest';
import {
    PLAN_FRESH_SECONDS, compactClaudeText, currentPlanPercent, displayedPlanPercent, secondsUntilPlanExpires, todayFreshTokens,
} from '../../src/core/compact.js';
import type {PlanUsage, UsageSnapshot} from '../../src/core/protocol.js';

const now = 1_792_150_000;
const usage: UsageSnapshot = {
    today: {
        day: '2026-10-16',
        models: {
            'claude-opus-5-5': {input: 100_000, cacheWrite: 900_000, cacheRead: 5_000_000, output: 20_000},
            'claude-haiku-5-5': {input: 0, cacheWrite: 100_000, cacheRead: 0, output: 0},
        },
    },
    history: [],
};
const plan: PlanUsage = {measuredAt: now - 60, fiveHour: {usedPercentage: 32.6, resetsAt: now + 3600}};

describe('todayFreshTokens', () => {
    it('sums fresh tokens over all models, without cache reads', () => {
        expect(todayFreshTokens(usage)).toBe(1_120_000);
    });

    it('is 0 without data', () => {
        expect(todayFreshTokens(null)).toBe(0);
        expect(todayFreshTokens({today: null, history: []})).toBe(0);
    });
});

describe('currentPlanPercent', () => {
    it('rounds a recent 5-hour figure', () => {
        expect(currentPlanPercent(plan, now)).toBe(33);
    });

    it('shows a recent figure without a reset time (the desktop app records none)', () => {
        const desktop: PlanUsage = {measuredAt: now - 600, source: 'desktop', fiveHour: {usedPercentage: 45}};
        expect(currentPlanPercent(desktop, now)).toBe(45);
        expect(secondsUntilPlanExpires(desktop, now)).toBe(PLAN_FRESH_SECONDS - 600);
    });

    it("keeps a figure for the desktop app's 15-minute sampling interval", () => {
        expect(PLAN_FRESH_SECONDS).toBeGreaterThan(15 * 60);
    });

    it('drops a figure older than the freshness limit', () => {
        expect(currentPlanPercent({...plan, measuredAt: now - PLAN_FRESH_SECONDS - 1}, now)).toBeNull();
    });

    it('drops a window that has reset', () => {
        expect(currentPlanPercent({...plan, fiveHour: {usedPercentage: 80, resetsAt: now}}, now)).toBeNull();
    });

    it('ignores the weekly window', () => {
        expect(currentPlanPercent({measuredAt: now, sevenDay: {usedPercentage: 4, resetsAt: now + 10}}, now)).toBeNull();
    });
});

describe('secondsUntilPlanExpires', () => {
    it('is the time until the figure goes stale', () => {
        expect(secondsUntilPlanExpires(plan, now)).toBe(PLAN_FRESH_SECONDS - 60);
    });

    it('is the time until the window resets, when that comes first', () => {
        expect(secondsUntilPlanExpires({...plan, fiveHour: {usedPercentage: 5, resetsAt: now + 30}}, now)).toBe(30);
    });

    it('is null when nothing is shown', () => {
        expect(secondsUntilPlanExpires(null, now)).toBeNull();
        expect(secondsUntilPlanExpires({...plan, measuredAt: now - PLAN_FRESH_SECONDS - 1}, now)).toBeNull();
    });
});

describe('compactClaudeText', () => {
    it.each([
        [usage, plan, 'Claude 1.12M · 33%'],
        [usage, null, 'Claude 1.12M'],
        [null, plan, 'Claude 33%'],
        [null, null, 'Claude'],
    ])('%#: %s', (u, p, expected) => {
        expect(compactClaudeText(u, p, now)).toBe(expected);
    });
});

describe('estimated plan percentage', () => {
    const measured: PlanUsage = {measuredAt: now - 120, source: 'desktop', fiveHour: {usedPercentage: 27}};
    const estimate = (fiveHour: number, basedOn = measured.measuredAt) => ({fiveHour, basedOn, at: now});

    it('shows the estimate with a tilde while it extends this very reading', () => {
        expect(displayedPlanPercent(measured, estimate(31.4), now)).toEqual({percent: 31, estimated: true});
        expect(compactClaudeText(usage, measured, now, estimate(31.4))).toBe('Claude 1.12M · ≈31%');
    });

    it('shows the measurement when there is no estimate, or it is not above it', () => {
        expect(displayedPlanPercent(measured, null, now)).toEqual({percent: 27, estimated: false});
        expect(displayedPlanPercent(measured, estimate(27.4), now)).toEqual({percent: 27, estimated: false});
        expect(compactClaudeText(usage, measured, now)).toBe('Claude 1.12M · 27%');
    });

    it('drops an estimate of an older reading at once: a new measurement wins', () => {
        const newer: PlanUsage = {...measured, measuredAt: now - 10, fiveHour: {usedPercentage: 29}};
        expect(displayedPlanPercent(newer, estimate(31, measured.measuredAt), now)).toEqual({percent: 29, estimated: false});
    });

    it('shows nothing when the reading is too old, estimate or not', () => {
        const old: PlanUsage = {...measured, measuredAt: now - PLAN_FRESH_SECONDS - 1};
        expect(displayedPlanPercent(old, estimate(35, old.measuredAt), now)).toBeNull();
    });
});
