// SPDX-License-Identifier: GPL-2.0-or-later
import {describe, expect, it} from 'vitest';
import {
    MAX_ESTIMATE_AGE_S, MAX_RISE_POINTS, estimateFiveHour, pointsPerDollar, sameEstimate,
    type PlanSample, type WeightBetween,
} from '../../src/core/planEstimate.js';
import type {PlanUsage} from '../../src/core/protocol.js';

const T0 = 1_792_000_000;
const MIN = 60;

/** Consumption that rises the window by `pace` points per dollar: $1 per request, one request at each `times`. */
function consumption(times: number[]): WeightBetween {
    return (from, to) => times.filter(t => t > from && t <= to).length;
}

/** Samples every 15 minutes whose figure rises 2 points per consumed dollar. */
function history(figures: number[], start = T0): PlanSample[] {
    return figures.map((fiveHour, i) => ({at: start + i * 15 * MIN, fiveHour}));
}

describe('pointsPerDollar', () => {
    // One dollar every 5 minutes: 3 per interval, so 6 points per interval.
    const times = Array.from({length: 40}, (_, i) => T0 + 1 + i * 5 * MIN);

    it('learns the pace from consecutive samples', () => {
        expect(pointsPerDollar(history([0, 6, 12, 18, 24, 30]), consumption(times))).toBeCloseTo(2, 5);
    });

    it('needs a few intervals and enough of a rise to go by', () => {
        expect(pointsPerDollar(history([0, 6, 12]), consumption(times))).toBeNull();
        expect(pointsPerDollar(history([10, 11, 11, 12, 12, 12]), consumption(times))).toBeNull();
    });

    it('needs at least four intervals even when they rise a lot', () => {
        expect(pointsPerDollar(history([0, 8, 16, 24]), consumption(times))).toBeNull();      // 3 intervals, +24 points
        expect(pointsPerDollar(history([0, 8, 16, 24, 32]), consumption(times))).not.toBeNull();
    });

    it('does not learn from a long gap between samples, nor from rises with nothing consumed', () => {
        const base = history([0, 6, 12, 18, 24]);                                              // pace 2
        // Three hours later: a big rise that would pull the pace to 2.25 if it counted.
        const gap = [...base, {at: T0 + 4 * 15 * MIN + 3 * 3600, fiveHour: 90}];
        expect(pointsPerDollar(gap, consumption(times))).toBeCloseTo(2, 5);
        // Rises while nothing was consumed here (use elsewhere): they say nothing about the pace.
        const elsewhere = [...base, ...[1, 2, 3, 4].map(i => ({at: T0 + 20 * 3600 + i * 15 * MIN, fiveHour: 24 + i * 6}))];
        expect(pointsPerDollar(elsewhere, consumption(times))).toBeCloseTo(2, 5);
    });

    it('skips intervals with a reset (the figure fell), saturation, a gap or nothing consumed', () => {
        const samples: PlanSample[] = [
            ...history([0, 6, 12, 18, 24]),                                   // 4 good intervals (pace 2)
            {at: T0 + 5 * 15 * MIN, fiveHour: 3},                             // fell: a new window
            {at: T0 + 6 * 15 * MIN, fiveHour: 100},                           // saturated
            {at: T0 + 20 * 15 * MIN, fiveHour: 99},                           // hours later
        ];
        expect(pointsPerDollar(samples, consumption(times))).toBeCloseTo(2, 5);
        expect(pointsPerDollar(samples, () => 0)).toBeNull();
    });

    it('ignores samples that have no 5-hour figure', () => {
        const samples = history([0, 6, 12, 18, 24, 30, 36, 42]).map((s, i) => (i === 3 ? {at: s.at, sevenDay: 5} : s));
        expect(pointsPerDollar(samples, consumption(times))).toBeCloseTo(2, 5);   // the two intervals around it are lost
    });

    it('learns from the latest intervals only, not from older ones at another pace', () => {
        // 45 old samples at 2 points per dollar, then 45 recent ones at 0.5: $1 in every interval.
        const old: PlanSample[] = Array.from({length: 45}, (_, i) => ({at: T0 + i * 15 * MIN, fiveHour: i * 2}));
        const start = T0 + 45 * 15 * MIN + 4 * 3600;
        const recent: PlanSample[] = Array.from({length: 45}, (_, i) => ({at: start + i * 15 * MIN, fiveHour: 10 + i * 0.5}));
        const midpoints = [...old, ...recent].flatMap((sample, i, all) => (i === 0 ? [] : [(all[i - 1].at + sample.at) / 2]));
        expect(pointsPerDollar([...old, ...recent], consumption(midpoints))).toBeCloseTo(0.5, 5);
    });

    it.each([
        ['implausibly slow', 0.0001],
        ['implausibly fast', 1000],
    ])('refuses a pace that is %s', (_name, perDollar) => {
        // Consumption scaled so that the pace comes out at perDollar.
        const scaled: WeightBetween = (from, to) => consumption(times)(from, to) * (2 / perDollar);
        expect(pointsPerDollar(history([0, 6, 12, 18, 24, 30]), scaled)).toBeNull();
    });
});

describe('estimateFiveHour', () => {
    const samples = history([0, 6, 12, 18, 24, 30]);      // pace 2 points per dollar
    const measuredAt = samples.at(-1)!.at;                // T0 + 75 min
    // $1 every 5 minutes up to the last measurement: what the pace was learned from.
    const past = Array.from({length: 15}, (_, i) => T0 + 1 + i * 5 * MIN).filter(t => t <= measuredAt);
    const plan = (used: number, extra: Partial<PlanUsage> = {}): PlanUsage => ({
        measuredAt, source: 'desktop', fiveHour: {usedPercentage: used}, ...extra,
    });
    const weight = consumption([...past, measuredAt + 1 * MIN, measuredAt + 3 * MIN]);

    it('extends the measurement with what was consumed since', () => {
        // Two dollars since the measurement: +4 points.
        expect(estimateFiveHour(plan(30), samples, measuredAt + 4 * MIN, weight)).toEqual({fiveHour: 34, basedOn: measuredAt, at: measuredAt + 4 * MIN});
    });

    it('says nothing when nothing was consumed since', () => {
        expect(estimateFiveHour(plan(30), samples, measuredAt + 30, consumption(past))).toBeNull();
    });

    it('says nothing for a rise too small to be worth showing', () => {
        const little: WeightBetween = (from, to) => (to > measuredAt ? 0.1 : consumption(past)(from, to));   // +0.2 points
        expect(estimateFiveHour(plan(30), samples, measuredAt + 4 * MIN, little)).toBeNull();
        const some: WeightBetween = (from, to) => (to > measuredAt ? 0.3 : consumption(past)(from, to));     // +0.6 points
        expect(estimateFiveHour(plan(30), samples, measuredAt + 4 * MIN, some)?.fiveHour).toBeCloseTo(30.6, 5);
    });

    it('never rises more than the cap above the measurement, nor past 100', () => {
        const heavy: WeightBetween = (from, to) => (to > measuredAt ? 1000 : consumption(past)(from, to));
        expect(estimateFiveHour(plan(30), samples, measuredAt + 4 * MIN, heavy)?.fiveHour).toBe(30 + MAX_RISE_POINTS);
        expect(estimateFiveHour(plan(90), samples, measuredAt + 4 * MIN, heavy)?.fiveHour).toBe(100);
    });

    it('does not estimate a saturated window, a missing reading or a window known to have reset', () => {
        const at = measuredAt + 4 * MIN;
        expect(estimateFiveHour(plan(100), samples, at, weight)).toBeNull();
        expect(estimateFiveHour(null, samples, at, weight)).toBeNull();
        expect(estimateFiveHour({measuredAt, sevenDay: {usedPercentage: 5}}, samples, at, weight)).toBeNull();
        expect(estimateFiveHour(plan(30, {fiveHour: {usedPercentage: 30, resetsAt: at - 1}}), samples, at, weight)).toBeNull();
    });

    it('extends a window whose reset time is still ahead', () => {
        expect(estimateFiveHour(plan(30, {fiveHour: {usedPercentage: 30, resetsAt: measuredAt + 3600}}), samples, measuredAt + 4 * MIN, weight)).not.toBeNull();
    });

    it('stops extending a measurement that is too old (the app is probably not running)', () => {
        const late = measuredAt + MAX_ESTIMATE_AGE_S + 1;
        expect(estimateFiveHour(plan(30), samples, late, () => 5)).toBeNull();
        expect(estimateFiveHour(plan(30), samples, measuredAt + MAX_ESTIMATE_AGE_S, () => 5)).not.toBeNull();
    });

    it('does not extend a measurement from the future', () => {
        expect(estimateFiveHour(plan(30), samples, measuredAt - 1, weight)).toBeNull();
    });

    it('says nothing without a pace to go by', () => {
        expect(estimateFiveHour(plan(30), history([0, 6]), measuredAt + 4 * MIN, weight)).toBeNull();
    });
});

describe('sameEstimate', () => {
    const e = (fiveHour: number, basedOn = 1) => ({fiveHour, basedOn, at: 5});

    it('compares the whole percentage and the reading', () => {
        expect(sameEstimate(e(34.2), e(33.6))).toBe(true);
        expect(sameEstimate(e(34.2), e(34.6))).toBe(false);
        expect(sameEstimate(e(34), e(34, 2))).toBe(false);
        expect(sameEstimate(null, null)).toBe(true);
        expect(sameEstimate(e(34), null)).toBe(false);
        expect(sameEstimate(null, e(34))).toBe(false);
    });
});
