// SPDX-License-Identifier: GPL-2.0-or-later

/** YYYY-MM-DD, `days` days before `day` (calendar arithmetic, no time zone involved). */
export function daysBefore(day: string, days: number): string {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, date - days)).toISOString().slice(0, 10);
}

/**
 * `count` calendar days ending with `today`, newest first. Counting back in calendar days, not
 * in multiples of 24 hours: a day with a time change has 23 or 25 hours, and subtracting 86,400
 * seconds from a time just after midnight lands two calendar days back.
 */
export function lastDays(today: string, count: number): string[] {
    return Array.from({length: count}, (_, i) => daysBefore(today, i));
}
