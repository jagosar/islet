// SPDX-License-Identifier: GPL-2.0-or-later
import type {UsageSnapshot} from '../protocol.js';
import type {ModelTotals} from './aggregator.js';
import {freshTokens} from './claudeTranscript.js';

/** 26 weeks, the span of the usage graph. */
export const HISTORY_DAYS = 26 * 7;

/** YYYY-MM-DD, `days` days before `day` (calendar arithmetic, no time zone involved). */
export function daysBefore(day: string, days: number): string {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, date - days)).toISOString().slice(0, 10);
}

/**
 * The Usage document: today's totals per model and fresh tokens for each day with usage in the
 * last HISTORY_DAYS days (including today), oldest first.
 */
export function buildUsageSnapshot(days: Map<string, ModelTotals>, today: string): UsageSnapshot {
    const first = daysBefore(today, HISTORY_DAYS - 1);
    const history = [...days]
        .filter(([day]) => day >= first && day <= today)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, models]) => ({day, fresh: [...models.values()].reduce((sum, tokens) => sum + freshTokens(tokens), 0)}))
        .filter(entry => entry.fresh > 0);

    const todayModels = days.get(today);
    return {
        today: todayModels ? {day: today, models: Object.fromEntries([...todayModels].map(([m, t]) => [m, {...t}]))} : null,
        history,
    };
}
