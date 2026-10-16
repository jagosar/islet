// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The spool: where the bridges leave what they could not deliver because the daemon was not
 * running (the extension, and with it the daemon, is switched off while the screen is locked).
 * The daemon replays the entries when it starts, so sessions and plan usage converge again.
 *
 * Entries are small JSON files in $XDG_RUNTIME_DIR/islet/spool, written atomically by the bridges.
 */

export type SpoolEntry =
    | {kind: 'agent-event'; at: number; fields: Record<string, string>}
    | {kind: 'plan-usage'; at: number; fields: Record<string, number>};

/** The latest plan usage a bridge could not deliver; each report replaces the one before. */
export const PLAN_SPOOL_FILE = 'plan-usage.json';

/** Whether a file name in the spool directory is one of ours (anything else is left alone). */
export function isSpoolFileName(name: string): boolean {
    return name === PLAN_SPOOL_FILE || /^\d{15}-\d{6}-agent-event\.json$/.test(name);
}

/** Entries older than this are not news any more. */
export const SPOOL_MAX_AGE_S = 6 * 3600;
/** The most entries kept (and the most a bridge will leave behind). */
export const MAX_SPOOL_ENTRIES = 500;
const MAX_FIELDS = 16;
/** Tolerance for a clock that moved back. */
const CLOCK_SKEW_S = 60;

export function encodeSpoolEntry(entry: SpoolEntry): string {
    return JSON.stringify(entry);
}

function isTime(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Validates an entry read from disk (any process of the user can write there). */
export function decodeSpoolEntry(text: string): SpoolEntry | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return null;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return null;
    const {kind, at, fields} = value as Record<string, unknown>;
    if (!isTime(at) || typeof fields !== 'object' || fields === null || Array.isArray(fields))
        return null;
    const entries = Object.entries(fields);
    if (entries.length > MAX_FIELDS)
        return null;

    if (kind === 'agent-event' && entries.every(([, v]) => typeof v === 'string'))
        return {kind, at, fields: fields as Record<string, string>};
    if (kind === 'plan-usage' && entries.every(([, v]) => typeof v === 'number' && Number.isFinite(v)))
        return {kind, at, fields: fields as Record<string, number>};
    return null;
}

/**
 * A file name that sorts in the order things happened: the time in milliseconds, a counter for
 * entries within the same millisecond, and the kind.
 */
export function spoolFileName(at: number, counter: number, kind: 'agent-event'): string {
    const millis = Math.round(at * 1000).toString().padStart(15, '0');
    return `${millis}-${counter.toString().padStart(6, '0')}-${kind}.json`;
}

export interface NamedEntry {
    name: string;
    entry: SpoolEntry;
}

/**
 * Chooses what to replay and what to delete: stale and future entries are discarded, and when
 * more than MAX_SPOOL_ENTRIES remain, the oldest go. `use` is in replay order.
 */
export function selectSpoolEntries(entries: NamedEntry[], now: number): {use: NamedEntry[]; discard: NamedEntry[]} {
    const discard: NamedEntry[] = [];
    const fresh: NamedEntry[] = [];
    for (const item of entries) {
        if (now - item.entry.at > SPOOL_MAX_AGE_S || item.entry.at - now > CLOCK_SKEW_S)
            discard.push(item);
        else
            fresh.push(item);
    }
    fresh.sort((a, b) => a.name.localeCompare(b.name));
    const excess = Math.max(0, fresh.length - MAX_SPOOL_ENTRIES);
    return {use: fresh.slice(excess), discard: [...discard, ...fresh.slice(0, excess)]};
}
