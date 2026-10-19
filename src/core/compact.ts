// SPDX-License-Identifier: GPL-2.0-or-later

import {formatTokens} from './format.js';
import type {PlanEstimate, PlanUsage, UsageSnapshot} from './protocol.js';
import {freshTokens} from './usage/claudeTranscript.js';

/**
 * Plan figures arrive while a terminal session runs or the desktop app records them (every
 * ~15 minutes), so the capsule shows the percentage only while it is recent; the expanded view
 * says when it was measured.
 */
export const PLAN_FRESH_SECONDS = 30 * 60;

/** Today's fresh tokens across all models, or 0. */
export function todayFreshTokens(usage: UsageSnapshot | null): number {
    if (!usage?.today)
        return 0;
    return Object.values(usage.today.models).reduce((sum, tokens) => sum + freshTokens(tokens), 0);
}

/** The 5-hour percentage if it was measured recently and its window has not reset. */
export function currentPlanPercent(plan: PlanUsage | null, now: number): number | null {
    const window = plan?.fiveHour;
    if (!plan || !window || now - plan.measuredAt > PLAN_FRESH_SECONDS || (window.resetsAt !== undefined && window.resetsAt <= now))
        return null;
    return Math.round(window.usedPercentage);
}

/**
 * The 5-hour percentage to show: the measured one, or the estimate extending it while there is
 * one for this very reading (an estimate of an older reading is dropped at once, so a new
 * measurement always wins).
 */
export function displayedPlanPercent(
    plan: PlanUsage | null,
    estimate: PlanEstimate | null,
    now: number,
): {percent: number; estimated: boolean} | null {
    const measured = currentPlanPercent(plan, now);
    if (measured === null)
        return null;
    if (plan && estimate && estimate.basedOn === plan.measuredAt && Math.round(estimate.fiveHour) > measured)
        return {percent: Math.round(estimate.fiveHour), estimated: true};
    return {percent: measured, estimated: false};
}

/**
 * Seconds until the plan percentage stops being shown (it goes stale or its window resets), or
 * null if nothing is shown. Lets the Shell refresh the capsule once, instead of ticking.
 */
export function secondsUntilPlanExpires(plan: PlanUsage | null, now: number): number | null {
    if (currentPlanPercent(plan, now) === null || !plan?.fiveHour)
        return null;
    return Math.max(1, Math.min(plan.measuredAt + PLAN_FRESH_SECONDS, plan.fiveHour.resetsAt ?? Number.POSITIVE_INFINITY) - now);
}

/** "Claude 1.12M · 33%", "Claude 1.12M · ≈35%" (estimated), "Claude 1.12M", "Claude 33%" or "Claude". */
export function compactClaudeText(usage: UsageSnapshot | null, plan: PlanUsage | null, now: number, estimate: PlanEstimate | null = null): string {
    const fresh = todayFreshTokens(usage);
    const shown = displayedPlanPercent(plan, estimate, now);
    const percent = shown === null ? null : `${shown.estimated ? '≈' : ''}${shown.percent}%`;
    const parts = [fresh > 0 ? formatTokens(fresh) : null, percent].filter(part => part !== null);
    return parts.length ? `Claude ${parts.join(' · ')}` : 'Claude';
}
