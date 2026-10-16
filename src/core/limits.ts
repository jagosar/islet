// SPDX-License-Identifier: GPL-2.0-or-later

import type {PlanUsage} from './protocol.js';

/**
 * A token bucket: `perSecond` calls on average, bursts of up to `burst`. The daemon is on the
 * session bus, where any process of the user can call it, so its methods are rate limited:
 * a runaway process must not be able to flood the capsule or the disk.
 */
export class RateLimiter {
    private tokens: number;
    private last = Number.NEGATIVE_INFINITY;

    constructor(private readonly perSecond: number, private readonly burst: number) {
        this.tokens = burst;
    }

    /** True if a call at `now` (seconds, any monotonic origin) is allowed. */
    take(now: number): boolean {
        if (now > this.last) {
            if (Number.isFinite(this.last))
                this.tokens = Math.min(this.burst, this.tokens + (now - this.last) * this.perSecond);
            this.last = now;
        }
        if (this.tokens < 1)
            return false;
        this.tokens -= 1;
        return true;
    }
}

/** Plan figures reported again unchanged are republished and saved at most this often. */
export const PLAN_REFRESH_S = 30;

function sameWindow(a: PlanUsage['fiveHour'], b: PlanUsage['fiveHour']): boolean {
    return a?.usedPercentage === b?.usedPercentage && a?.resetsAt === b?.resetsAt;
}

/**
 * What to do with a plan report. Claude Code runs the status line several times per second
 * during a reply, with the same figures: telling every client and rewriting the file each time
 * would be wasted work. A change in the figures goes out at once; the same figures only refresh
 * "measured at" every PLAN_REFRESH_S seconds. The latest report is always kept in memory.
 */
export function planUpdateActions(
    previous: PlanUsage | null,
    next: PlanUsage,
    last: {published: number; persisted: number},
    now: number,
): {publish: boolean; persist: boolean} {
    const changed = !previous || !sameWindow(previous.fiveHour, next.fiveHour) || !sameWindow(previous.sevenDay, next.sevenDay);
    return {
        publish: changed || now - last.published >= PLAN_REFRESH_S,
        persist: changed || now - last.persisted >= PLAN_REFRESH_S,
    };
}
