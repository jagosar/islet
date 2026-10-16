// SPDX-License-Identifier: GPL-2.0-or-later

import {formatTokens} from './format.js';
import type {PlanUsage, UsageSnapshot} from './protocol.js';
import {freshTokens} from './usage/claudeTranscript.js';

/**
 * Plan figures only refresh while a terminal session runs (spike S4), so the capsule shows the
 * percentage only while it is recent; the expanded view says when it was measured.
 */
export const PLAN_FRESH_SECONDS = 15 * 60;

/** Today's fresh tokens across all models, or 0. */
export function todayFreshTokens(usage: UsageSnapshot | null): number {
    if (!usage?.today)
        return 0;
    return Object.values(usage.today.models).reduce((sum, tokens) => sum + freshTokens(tokens), 0);
}

/** The 5-hour percentage if it was measured recently and its window has not reset. */
export function currentPlanPercent(plan: PlanUsage | null, now: number): number | null {
    const window = plan?.fiveHour;
    if (!plan || !window || now - plan.measuredAt > PLAN_FRESH_SECONDS || window.resetsAt <= now)
        return null;
    return Math.round(window.usedPercentage);
}

/**
 * Seconds until the plan percentage stops being shown (it goes stale or its window resets), or
 * null if nothing is shown. Lets the Shell refresh the capsule once, instead of ticking.
 */
export function secondsUntilPlanExpires(plan: PlanUsage | null, now: number): number | null {
    if (currentPlanPercent(plan, now) === null || !plan?.fiveHour)
        return null;
    return Math.max(1, Math.min(plan.measuredAt + PLAN_FRESH_SECONDS, plan.fiveHour.resetsAt) - now);
}

/** "Claude 1.12M · 33%", "Claude 1.12M", "Claude 33%" or "Claude". */
export function compactClaudeText(usage: UsageSnapshot | null, plan: PlanUsage | null, now: number): string {
    const fresh = todayFreshTokens(usage);
    const percent = currentPlanPercent(plan, now);
    const parts = [fresh > 0 ? formatTokens(fresh) : null, percent !== null ? `${percent}%` : null]
        .filter(part => part !== null);
    return parts.length ? `Claude ${parts.join(' · ')}` : 'Claude';
}
