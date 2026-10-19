// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Where the 5-hour plan window is *now*, between two measurements.
 *
 * The Claude desktop app records the plan percentages about every 15 minutes, and nothing more
 * frequent reaches this computer. In between, the percentage moves with what is used, and what
 * was used is in the transcripts. The size of one percentage point differs by plan, so it is
 * learned from the user's own history: over each pair of consecutive samples, how many points the
 * window rose and how much was consumed in that time (at list prices, see requestWeight).
 *
 * Checked on a real history, walking forward and learning only from the past (see
 * scripts/plan-estimate-report.mjs): over 27 intervals of 15 minutes the estimate of the next
 * sample was off by 2.6 points on average (median 1.4, 90 % under 4.9), and the actual rise was
 * 0.96 times the estimated one (middle value). An estimate is always shown as one ("≈"), snaps to
 * the next measurement, and is never used for thresholds or alerts.
 */
import type {PlanEstimate, PlanUsage} from './protocol.js';

/** One measurement of the desktop app's history. Percentages are 0 to 100. */
export interface PlanSample {
    /** Unix epoch seconds. */
    at: number;
    fiveHour?: number;
    sevenDay?: number;
}

/** Consumption between two Unix epoch second instants (from exclusive, to inclusive), in dollars. */
export type WeightBetween = (from: number, to: number) => number;

/** Samples further apart than this say nothing about the pace (the app was not running). */
export const MAX_INTERVAL_S = 25 * 60;
/** How many of the latest usable intervals the pace is learned from. */
export const MAX_INTERVALS = 40;
/** Fewer intervals, or a smaller total rise, are too little to learn the pace from. */
export const MIN_INTERVALS = 4;
export const MIN_TOTAL_RISE = 20;
/** Plausible pace, in percentage points per dollar: outside it the data is not what was assumed. */
export const MIN_POINTS_PER_DOLLAR = 0.05;
export const MAX_POINTS_PER_DOLLAR = 50;
/** A measurement older than this is not extended: the app is probably not running. */
export const MAX_ESTIMATE_AGE_S = 40 * 60;
/** An estimate never goes further than this above its measurement. */
export const MAX_RISE_POINTS = 30;
/** Smaller differences are not worth showing. */
export const MIN_RISE_POINTS = 0.5;

/**
 * Percentage points per dollar of consumption, from the latest usable intervals of `samples`
 * (sorted by time), or null when there is too little to go by. An interval is usable if both
 * samples have the 5-hour figure, they are at most MAX_INTERVAL_S apart, the window did not reset
 * or saturate in between, and something was consumed.
 */
export function pointsPerDollar(samples: readonly PlanSample[], weightBetween: WeightBetween): number | null {
    let rise = 0;
    let weight = 0;
    let used = 0;
    for (let i = samples.length - 1; i > 0 && used < MAX_INTERVALS; i--) {
        const a = samples[i - 1];
        const b = samples[i];
        if (a.fiveHour === undefined || b.fiveHour === undefined)
            continue;
        const seconds = b.at - a.at;
        if (seconds <= 0 || seconds > MAX_INTERVAL_S || b.fiveHour < a.fiveHour || b.fiveHour >= 100)
            continue;
        const consumed = weightBetween(a.at, b.at);
        if (!(consumed > 0))
            continue;
        rise += b.fiveHour - a.fiveHour;
        weight += consumed;
        used++;
    }
    if (used < MIN_INTERVALS || rise < MIN_TOTAL_RISE)
        return null;
    const pace = rise / weight;
    return pace >= MIN_POINTS_PER_DOLLAR && pace <= MAX_POINTS_PER_DOLLAR ? pace : null;
}

/**
 * The estimate for the 5-hour window at `now`, or null when there is nothing to add: no recent
 * measurement, a window known to have reset, a saturated one, no pace to go by, or nothing used
 * since the measurement.
 */
export function estimateFiveHour(
    plan: PlanUsage | null,
    samples: readonly PlanSample[],
    now: number,
    weightBetween: WeightBetween,
): PlanEstimate | null {
    const window = plan?.fiveHour;
    if (!plan || !window || window.usedPercentage >= 100)
        return null;
    const age = now - plan.measuredAt;
    if (age < 0 || age > MAX_ESTIMATE_AGE_S)
        return null;
    if (window.resetsAt !== undefined && window.resetsAt <= now)
        return null;

    const pace = pointsPerDollar(samples, weightBetween);
    if (pace === null)
        return null;
    const consumed = weightBetween(plan.measuredAt, now);
    if (!(consumed > 0))
        return null;

    const rise = Math.min(MAX_RISE_POINTS, pace * consumed);
    const fiveHour = Math.min(100, window.usedPercentage + rise);
    if (fiveHour - window.usedPercentage < MIN_RISE_POINTS)
        return null;
    return {fiveHour, basedOn: plan.measuredAt, at: now};
}

/** True when two estimates would look the same: the same reading and the same whole percentage. */
export function sameEstimate(a: PlanEstimate | null, b: PlanEstimate | null): boolean {
    if (a === null || b === null)
        return a === b;
    return a.basedOn === b.basedOn && Math.round(a.fiveHour) === Math.round(b.fiveHour);
}
