// SPDX-License-Identifier: GPL-2.0-or-later
import {describe, expect, it} from 'vitest';
import {PLAN_REFRESH_S, RateLimiter, planUpdateActions} from '../../src/core/limits.js';
import type {PlanUsage} from '../../src/core/protocol.js';

const plan = (percent: number, measuredAt: number, resetsAt = 9000): PlanUsage => ({measuredAt, fiveHour: {usedPercentage: percent, resetsAt}});

describe('RateLimiter', () => {
    it('lets a burst through, then drops what exceeds the rate', () => {
        const limiter = new RateLimiter(10, 5);
        const accepted = Array.from({length: 20}, () => limiter.take(0)).filter(Boolean).length;
        expect(accepted).toBe(5);
    });

    it('refills over time, never above the burst', () => {
        const limiter = new RateLimiter(10, 5);
        for (let i = 0; i < 5; i++)
            limiter.take(0);
        expect(limiter.take(0)).toBe(false);
        expect(limiter.take(0.1)).toBe(true); // 10 per second: one token after 100 ms.
        expect(limiter.take(0.1)).toBe(false);
        const later = Array.from({length: 20}, () => limiter.take(100)).filter(Boolean).length;
        expect(later).toBe(5);
    });

    it('tolerates a clock that moves back', () => {
        const limiter = new RateLimiter(10, 2);
        limiter.take(100);
        expect(() => limiter.take(50)).not.toThrow();
    });
});

describe('planUpdateActions', () => {
    it('publishes and persists the first report', () => {
        expect(planUpdateActions(null, plan(10, 100), {published: 0, persisted: 0}, 100)).toEqual({publish: true, persist: true});
    });

    it('publishes and persists a change in the figures at once', () => {
        expect(planUpdateActions(plan(10, 100), plan(11, 101), {published: 100, persisted: 100}, 101)).toEqual({publish: true, persist: true});
        expect(planUpdateActions(plan(10, 100, 9000), plan(10, 101, 9500), {published: 100, persisted: 100}, 101)).toEqual({publish: true, persist: true});
    });

    it('does nothing for the same figures reported again, until the refresh interval', () => {
        const last = {published: 100, persisted: 100};
        expect(planUpdateActions(plan(10, 100), plan(10, 101), last, 101)).toEqual({publish: false, persist: false});
        expect(planUpdateActions(plan(10, 100), plan(10, 130), last, 100 + PLAN_REFRESH_S - 1)).toEqual({publish: false, persist: false});
        expect(planUpdateActions(plan(10, 100), plan(10, 131), last, 100 + PLAN_REFRESH_S)).toEqual({publish: true, persist: true});
    });

    it('treats a window that appears or disappears as a change', () => {
        const both: PlanUsage = {measuredAt: 100, fiveHour: {usedPercentage: 1, resetsAt: 9}, sevenDay: {usedPercentage: 2, resetsAt: 9}};
        expect(planUpdateActions(both, plan(1, 101, 9), {published: 100, persisted: 100}, 101).publish).toBe(true);
    });
});
