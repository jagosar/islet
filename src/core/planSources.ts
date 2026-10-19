// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Claude plan usage from the three local places it shows up, merged into one PlanUsage:
 *
 * - the status line bridge (terminal sessions): both windows with their reset times;
 * - the Claude desktop app's own history, `plan-usage-history.json` in its configuration
 *   folder: both percentages, every ~15 minutes while the app runs, without reset times;
 * - "You've hit your … limit · resets …" messages in transcripts: 100% and the reset time.
 *
 * None of them needs a network request or a credential.
 */
import type {PlanSample} from './planEstimate.js';
import type {PlanSource, PlanUsage, PlanWindow} from './protocol.js';
import type {LimitHit} from './usage/claudeTranscript.js';

/** File name of the desktop app's history, in $XDG_CONFIG_HOME/Claude. */
export const DESKTOP_HISTORY_FILE = 'plan-usage-history.json';

/** A reading counts as the same window if its percentage did not drop by more than this. */
const SAME_WINDOW_TOLERANCE = 1;

function isPercent(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

/**
 * The latest sample of the desktop app's history: {"version": 2, "samples": [{"t": epochMs,
 * "org": "…", "u": {"fh": 5-hour %, "sd": 7-day %}}]}. Null for anything else; an unknown future
 * shape is skipped rather than misread.
 */
export function parseDesktopPlanHistory(text: string): PlanUsage | null {
    let document: unknown;
    try {
        document = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof document !== 'object' || document === null)
        return null;
    const samples = (document as Record<string, unknown>).samples;
    if (!Array.isArray(samples))
        return null;

    let latest: {t: number; fh?: number; sd?: number} | null = null;
    for (const sample of samples) {
        if (typeof sample !== 'object' || sample === null)
            continue;
        const {t, u} = sample as Record<string, unknown>;
        if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || typeof u !== 'object' || u === null)
            continue;
        const {fh, sd} = u as Record<string, unknown>;
        if (!isPercent(fh) && !isPercent(sd))
            continue;
        if (!latest || t > latest.t)
            latest = {t, ...(isPercent(fh) ? {fh} : {}), ...(isPercent(sd) ? {sd} : {})};
    }
    if (!latest)
        return null;
    return {
        measuredAt: Math.floor(latest.t / 1000),
        source: 'desktop',
        ...(latest.fh !== undefined ? {fiveHour: {usedPercentage: latest.fh}} : {}),
        ...(latest.sd !== undefined ? {sevenDay: {usedPercentage: latest.sd}} : {}),
    };
}

/** Samples kept for learning the pace: about a week of readings every 15 minutes, plus margin. */
const MAX_SAMPLES = 1000;

/**
 * Every sample of the desktop app's history, oldest first, for learning how fast the 5-hour
 * window rises (see planEstimate.ts). Samples that are not readable are skipped; null for a
 * document that is not a history at all.
 */
export function parseDesktopPlanSamples(text: string): PlanSample[] | null {
    let document: unknown;
    try {
        document = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof document !== 'object' || document === null)
        return null;
    const samples = (document as Record<string, unknown>).samples;
    if (!Array.isArray(samples))
        return null;

    const result: PlanSample[] = [];
    for (const sample of samples) {
        if (typeof sample !== 'object' || sample === null)
            continue;
        const {t, u} = sample as Record<string, unknown>;
        if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || typeof u !== 'object' || u === null)
            continue;
        const {fh, sd} = u as Record<string, unknown>;
        if (!isPercent(fh) && !isPercent(sd))
            continue;
        result.push({at: Math.floor(t / 1000), ...(isPercent(fh) ? {fiveHour: fh} : {}), ...(isPercent(sd) ? {sevenDay: sd} : {})});
    }
    result.sort((x, y) => x.at - y.at);
    return result.slice(-MAX_SAMPLES);
}

/** The plan reading a limit message implies: its window at 100% until the reset. Null if it says nothing usable now. */
export function planFromLimitHit(hit: LimitHit, now: number): PlanUsage | null {
    if (hit.resetsAt === undefined || hit.resetsAt <= now)
        return null;
    const window: PlanWindow = {usedPercentage: 100, resetsAt: hit.resetsAt};
    if (hit.window === 'session')
        return {measuredAt: hit.at, source: 'limit', fiveHour: window};
    if (hit.window === 'weekly')
        return {measuredAt: hit.at, source: 'limit', sevenDay: window};
    return null;
}

function mergeWindow(previous: PlanWindow | undefined, next: PlanWindow | undefined, previousAt: number, now: number): PlanWindow | undefined {
    if (!next) {
        // Not in the new reading (a limit message names one window): keep the other one unless
        // it is known to have reset.
        return previous && (previous.resetsAt === undefined || previous.resetsAt > now) ? previous : undefined;
    }
    if (next.resetsAt !== undefined || previous?.resetsAt === undefined)
        return next;
    // The new reading has no reset time: inherit the old one if it is still the same window
    // (it has not reset yet, and the percentage did not drop).
    const sameWindow = previous.resetsAt > Math.max(previousAt, now) &&
        next.usedPercentage >= previous.usedPercentage - SAME_WINDOW_TOLERANCE;
    return sameWindow ? {usedPercentage: next.usedPercentage, resetsAt: previous.resetsAt} : next;
}

/**
 * Combines the current figures with a new reading from any source. An older reading than the
 * current one is ignored (sources overlap: the desktop history repeats what a limit message
 * already said); otherwise each window takes the new value, keeping a known reset time while
 * it still applies.
 */
export function mergePlan(current: PlanUsage | null, next: PlanUsage, now: number): PlanUsage {
    if (!current)
        return next;
    if (next.measuredAt < current.measuredAt)
        return current;
    const fiveHour = mergeWindow(current.fiveHour, next.fiveHour, current.measuredAt, now);
    const sevenDay = mergeWindow(current.sevenDay, next.sevenDay, current.measuredAt, now);
    const source: PlanSource | undefined = next.source ?? current.source;
    return {
        measuredAt: next.measuredAt,
        ...(source ? {source} : {}),
        ...(fiveHour ? {fiveHour} : {}),
        ...(sevenDay ? {sevenDay} : {}),
    };
}
