// SPDX-License-Identifier: GPL-2.0-or-later

/** Formatting and layout for the expanded view, kept pure so it is unit tested. */
import type {SessionState, UsageSnapshot} from './protocol.js';
import {daysBefore} from './usage/snapshot.js';

type Translate = (text: string) => string;
const identity: Translate = text => text;

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(seconds: number, t: Translate = identity): string {
    if (seconds < 60)
        return t('just now');
    if (seconds < 3600)
        return t('%d min ago').replace('%d', String(Math.floor(seconds / 60)));
    if (seconds < 86400)
        return t('%d h ago').replace('%d', String(Math.floor(seconds / 3600)));
    const days = Math.floor(seconds / 86400);
    return (days === 1 ? t('1 day ago') : t('%d days ago')).replace('%d', String(days));
}

/** "5 min", "3 h 20 min", for how long a session has been in its state. */
export function formatDuration(seconds: number, t: Translate = identity): string {
    const minutes = Math.floor(seconds / 60);
    if (minutes < 1)
        return t('<1 min');
    if (minutes < 60)
        return t('%d min').replace('%d', String(minutes));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? t('%d h %d min').replace('%d', String(hours)).replace('%d', String(rest)) : t('%d h').replace('%d', String(hours));
}

export function sessionStateLabel(state: SessionState, t: Translate = identity): string {
    switch (state) {
    case 'needs-permission':
        return t('needs permission');
    case 'waiting':
        return t('waiting for you');
    case 'working':
        return t('working');
    case 'finished':
        return t('finished');
    case 'idle':
        return t('idle');
    }
}

export const HEATMAP_WEEKS = 26;

/** Day of week with Monday = 0, for a YYYY-MM-DD date. */
function weekday(day: string): number {
    const [year, month, date] = day.split('-').map(Number);
    return (new Date(Date.UTC(year, month - 1, date)).getUTCDay() + 6) % 7;
}

export interface HeatmapCell {
    day: string;
    fresh: number;
    /** 0 (no usage) to 4 (busiest quarter of the days with usage). */
    level: number;
    /** False for days after today in the current week. */
    inRange: boolean;
}

/**
 * The 26-week usage graph: one column per week (Monday to Sunday), oldest first, ending with
 * the week that contains today. Levels split the days with usage into quartiles, so the graph
 * reads the same for light and heavy users.
 */
export function heatmapCells(usage: UsageSnapshot | null, today: string): HeatmapCell[][] {
    const fresh = new Map((usage?.history ?? []).map(entry => [entry.day, entry.fresh]));
    const used = [...fresh.values()].filter(value => value > 0).sort((a, b) => a - b);
    const quartile = (q: number) => used[Math.max(0, Math.ceil(q * used.length) - 1)];
    const level = (value: number) => {
        if (value <= 0 || !used.length)
            return 0;
        if (value <= quartile(0.25))
            return 1;
        if (value <= quartile(0.5))
            return 2;
        if (value <= quartile(0.75))
            return 3;
        return 4;
    };

    const lastMonday = daysBefore(today, weekday(today));
    const columns: HeatmapCell[][] = [];
    for (let week = HEATMAP_WEEKS - 1; week >= 0; week--) {
        const monday = daysBefore(lastMonday, week * 7);
        const column: HeatmapCell[] = [];
        for (let d = 0; d < 7; d++) {
            const day = daysBefore(monday, -d);
            const value = fresh.get(day) ?? 0;
            column.push({day, fresh: value, level: level(value), inRange: day <= today});
        }
        columns.push(column);
    }
    return columns;
}
