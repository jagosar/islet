// SPDX-License-Identifier: GPL-2.0-or-later
/** Token counts as the API bills them. Thinking tokens are already part of `output`. */
export interface TokenCounts {
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
}

/** One API response's usage, read from a Claude Code transcript line. */
export interface UsageRecord {
    messageId: string;
    sessionId: string;
    model: string;
    /** ISO 8601, UTC. */
    timestamp: string;
    tokens: TokenCounts;
}

/** Claude Code writes this model for local messages (errors, interruptions) that cost nothing. */
const SYNTHETIC_MODEL = '<synthetic>';

function count(value: unknown): number | null {
    if (value === undefined || value === null)
        return 0;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Reads the usage of one transcript line. Only metadata is touched: message content is never
 * read. Returns null for every line that is not a billable assistant response, including
 * malformed or truncated JSON.
 */
export function parseUsageLine(line: string): UsageRecord | null {
    let entry: unknown;
    try {
        entry = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof entry !== 'object' || entry === null)
        return null;

    const {type, message, sessionId, timestamp} = entry as Record<string, unknown>;
    if (type !== 'assistant' || typeof message !== 'object' || message === null)
        return null;

    const {id, model, usage} = message as Record<string, unknown>;
    if (typeof id !== 'string' || typeof model !== 'string' || model === SYNTHETIC_MODEL)
        return null;
    if (typeof sessionId !== 'string' || typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp)))
        return null;
    if (typeof usage !== 'object' || usage === null)
        return null;

    const u = usage as Record<string, unknown>;
    const input = count(u.input_tokens);
    const cacheWrite = count(u.cache_creation_input_tokens);
    const cacheRead = count(u.cache_read_input_tokens);
    const output = count(u.output_tokens);
    if (input === null || cacheWrite === null || cacheRead === null || output === null)
        return null;

    return {messageId: id, sessionId, model, timestamp, tokens: {input, cacheWrite, cacheRead, output}};
}

/** Claude Code's own totals for a session, written to its transcript when it ends. */
export interface CostState {
    sessionId: string;
    models: Map<string, TokenCounts>;
}

/** Reads a `cost-state` line; null for any other line or an invalid one. */
export function parseCostStateLine(line: string): CostState | null {
    if (!line.includes('"cost-state"'))
        return null;
    let entry: unknown;
    try {
        entry = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof entry !== 'object' || entry === null)
        return null;
    const {type, sessionId, modelUsage} = entry as Record<string, unknown>;
    if (type !== 'cost-state' || typeof sessionId !== 'string' || typeof modelUsage !== 'object' || modelUsage === null)
        return null;

    const models = new Map<string, TokenCounts>();
    for (const [model, usage] of Object.entries(modelUsage as Record<string, unknown>)) {
        if (typeof usage !== 'object' || usage === null)
            return null;
        const u = usage as Record<string, unknown>;
        const input = count(u.inputTokens);
        const cacheWrite = count(u.cacheCreationInputTokens);
        const cacheRead = count(u.cacheReadInputTokens);
        const output = count(u.outputTokens);
        if (input === null || cacheWrite === null || cacheRead === null || output === null)
            return null;
        models.set(model, {input, cacheWrite, cacheRead, output});
    }
    return {sessionId, models};
}

/**
 * Cheap pre-check before JSON.parse: transcripts are mostly conversation content, and only
 * assistant responses with usage and cost-state entries matter.
 */
export function mayHoldUsage(line: string): boolean {
    return (line.includes('"usage"') && line.includes('"assistant"')) || line.includes('"cost-state"');
}

/** Input + cache write + output: the new work of a response. */
export function freshTokens(tokens: TokenCounts): number {
    return tokens.input + tokens.cacheWrite + tokens.output;
}

/** Fresh + cache read: everything the model processed. */
export function processedTokens(tokens: TokenCounts): number {
    return freshTokens(tokens) + tokens.cacheRead;
}
