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

/** The calendar day of an ISO timestamp in `timeZone`, as YYYY-MM-DD. */
export function dayKey(timestamp: string, timeZone: string): string {
    return new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'})
        .format(new Date(timestamp));
}

/**
 * Collects usage records, counting each API response once.
 *
 * Claude Code repeats a response's usage on every content block line, and a resumed session
 * copies earlier responses into its new transcript, so records are keyed by message id across
 * all files. A repeated id replaces the earlier record (the repeats carry the same counts).
 */
export class UsageAggregator {
    private readonly records = new Map<string, UsageRecord>();

    add(record: UsageRecord): void {
        this.records.set(record.messageId, record);
    }

    get size(): number {
        return this.records.size;
    }

    /** Totals per model for each session. */
    bySession(): Map<string, ModelTotals> {
        return this.group(record => record.sessionId);
    }

    /** Totals per model for each local day in `timeZone`. */
    byDay(timeZone: string): Map<string, ModelTotals> {
        return this.group(record => dayKey(record.timestamp, timeZone));
    }

    private group(keyOf: (record: UsageRecord) => string): Map<string, ModelTotals> {
        const groups = new Map<string, ModelTotals>();
        for (const record of this.records.values()) {
            const key = keyOf(record);
            let models = groups.get(key);
            if (!models) {
                models = new Map();
                groups.set(key, models);
            }
            let totals = models.get(record.model);
            if (!totals) {
                totals = zero();
                models.set(record.model, totals);
            }
            addInto(totals, record.tokens);
        }
        return groups;
    }
}
