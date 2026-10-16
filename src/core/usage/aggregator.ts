// SPDX-License-Identifier: GPL-2.0-or-later

import type {TokenCounts, UsageRecord} from './claudeTranscript.js';

export type ModelTotals = Map<string, TokenCounts>;

function zero(): TokenCounts {
    return {input: 0, cacheWrite: 0, cacheRead: 0, output: 0};
}

function addInto(target: TokenCounts, tokens: TokenCounts): void {
    target.input += tokens.input;
    target.cacheWrite += tokens.cacheWrite;
    target.cacheRead += tokens.cacheRead;
    target.output += tokens.output;
}

function addToModel(models: ModelTotals, model: string, tokens: TokenCounts): void {
    let totals = models.get(model);
    if (!totals) {
        totals = zero();
        models.set(model, totals);
    }
    addInto(totals, tokens);
}

function cloneTotals(models: ModelTotals): ModelTotals {
    return new Map([...models].map(([model, tokens]) => [model, {...tokens}]));
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar day of an ISO timestamp in `timeZone`, as YYYY-MM-DD. */
export function dayKey(timestamp: string, timeZone: string): string {
    let formatter = formatters.get(timeZone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});
        formatters.set(timeZone, formatter);
    }
    return formatter.format(new Date(timestamp));
}

interface SessionTotals {
    models: ModelTotals;
    lastDay: string;
}

/**
 * Collects usage incrementally, counting each API response once, with bounded memory: it keeps
 * the ids it has seen and running totals, never the records.
 *
 * Claude Code repeats a response's usage on every content block line, and a resumed session
 * copies earlier responses into its new transcript, so a response is identified by its message
 * id across all files and the first occurrence counts (the repeats carry the same counts).
 *
 * Claude Code also makes calls it never writes to the transcript (spike S5). When a session
 * ends, its `cost-state` totals are set with setSessionReference(); queries then use them for
 * that session, booking the difference on the session's last day.
 */
export class UsageAggregator {
    private readonly seen = new Set<string>();
    private readonly days = new Map<string, ModelTotals>();
    private readonly sessions = new Map<string, SessionTotals>();
    private readonly references = new Map<string, ModelTotals>();

    constructor(private readonly timeZone: string) {}

    /** Adds a record; returns false if its response was already counted. */
    add(record: UsageRecord): boolean {
        if (this.seen.has(record.messageId))
            return false;
        this.seen.add(record.messageId);

        const day = dayKey(record.timestamp, this.timeZone);
        let models = this.days.get(day);
        if (!models) {
            models = new Map();
            this.days.set(day, models);
        }
        addToModel(models, record.model, record.tokens);

        let session = this.sessions.get(record.sessionId);
        if (!session) {
            session = {models: new Map(), lastDay: day};
            this.sessions.set(record.sessionId, session);
        }
        addToModel(session.models, record.model, record.tokens);
        if (day > session.lastDay)
            session.lastDay = day;
        return true;
    }

    /** Claude Code's own totals for an ended session (its `cost-state`). */
    setSessionReference(sessionId: string, models: ModelTotals): void {
        this.references.set(sessionId, cloneTotals(models));
    }

    get size(): number {
        return this.seen.size;
    }

    /** Transcript totals per model for each session (without references). */
    bySession(): Map<string, ModelTotals> {
        return new Map([...this.sessions].map(([id, session]) => [id, cloneTotals(session.models)]));
    }

    /** Totals per model for each local day, with ended sessions reconciled to their references. */
    byDay(): Map<string, ModelTotals> {
        const days = new Map([...this.days].map(([day, models]) => [day, cloneTotals(models)]));
        for (const [sessionId, reference] of this.references) {
            const session = this.sessions.get(sessionId);
            if (!session)
                continue;
            let models = days.get(session.lastDay);
            if (!models) {
                models = new Map();
                days.set(session.lastDay, models);
            }
            for (const [model, expected] of reference) {
                const counted = session.models.get(model) ?? zero();
                addToModel(models, model, {
                    input: Math.max(0, expected.input - counted.input),
                    cacheWrite: Math.max(0, expected.cacheWrite - counted.cacheWrite),
                    cacheRead: Math.max(0, expected.cacheRead - counted.cacheRead),
                    output: Math.max(0, expected.output - counted.output),
                });
            }
        }
        return days;
    }
}
