// SPDX-License-Identifier: GPL-2.0-or-later

/** The plan figures in Claude Code's status line input, as ReportPlanUsage fields. */
export type PlanReport = Record<string, number>;

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Reads `rate_limits.five_hour` and `rate_limits.seven_day` from the status line JSON. Only
 * those numbers leave the bridge. Null when the input has neither window (API users, or
 * before the session's first reply).
 */
export function planReportFromStatusLine(text: string): PlanReport | null {
    let input: unknown;
    try {
        input = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof input !== 'object' || input === null)
        return null;
    const limits = (input as Record<string, unknown>).rate_limits;
    if (typeof limits !== 'object' || limits === null)
        return null;

    const report: PlanReport = {};
    for (const [window, prefix] of [['five_hour', 'five_hour'], ['seven_day', 'seven_day']] as const) {
        const value = (limits as Record<string, unknown>)[window];
        if (typeof value !== 'object' || value === null)
            continue;
        const {used_percentage: used, resets_at: resetsAt} = value as Record<string, unknown>;
        if (isNumber(used) && isNumber(resetsAt)) {
            report[`${prefix}_used_percentage`] = used;
            report[`${prefix}_resets_at`] = resetsAt;
        }
    }
    return Object.keys(report).length ? report : null;
}

/** The status line Islet prints when the user had none of their own: "5h 33% · 7d 4%". */
export function formatPlanStatusLine(report: PlanReport | null): string {
    if (!report)
        return '';
    const parts: string[] = [];
    if (isNumber(report.five_hour_used_percentage))
        parts.push(`5h ${Math.round(report.five_hour_used_percentage)}%`);
    if (isNumber(report.seven_day_used_percentage))
        parts.push(`7d ${Math.round(report.seven_day_used_percentage)}%`);
    return parts.join(' · ');
}
