// SPDX-License-Identifier: GPL-2.0-or-later

/** Token counts as the API bills them. Thinking tokens are already part of `output`. */
export interface TokenCounts {
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
}

/**
 * What Claude Code attributes a response to, as it records it for its own `/usage` breakdown:
 * the MCP server whose tool result the request carried, the skill and the subagent it ran in,
 * and the plugin they came from. These are configuration names, not message content.
 */
export interface Attribution {
    mcpServer?: string;
    skill?: string;
    agent?: string;
    plugin?: string;
}

/** One API response's usage, read from a Claude Code transcript line. */
export interface UsageRecord {
    messageId: string;
    sessionId: string;
    model: string;
    /** ISO 8601, UTC. */
    timestamp: string;
    tokens: TokenCounts;
    /** True for a subagent's response. */
    sidechain: boolean;
    attribution: Attribution;
    /** Last segment of the working directory, when the line has one. */
    project?: string;
}

/** Claude Code writes this model for local messages (errors, interruptions) that cost nothing. */
const SYNTHETIC_MODEL = '<synthetic>';
/** Longer attribution names are cut: they are labels, and the daemon keeps them in memory. */
const MAX_NAME_LENGTH = 80;

function count(value: unknown): number | null {
    if (value === undefined || value === null)
        return 0;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function name(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_NAME_LENGTH) : undefined;
}

function lastSegment(path: unknown): string | undefined {
    if (typeof path !== 'string')
        return undefined;
    return name(path.split('/').filter(Boolean).at(-1));
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

    const {type, message, sessionId, timestamp, isSidechain, cwd} = entry as Record<string, unknown>;
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

    const e = entry as Record<string, unknown>;
    const attribution: Attribution = {};
    const mcpServer = name(e.attributionMcpServer);
    const skill = name(e.attributionSkill);
    const agent = name(e.attributionAgent);
    const plugin = name(e.attributionPlugin);
    if (mcpServer)
        attribution.mcpServer = mcpServer;
    if (skill)
        attribution.skill = skill;
    if (agent)
        attribution.agent = agent;
    if (plugin)
        attribution.plugin = plugin;

    const project = lastSegment(cwd);
    return {
        messageId: id, sessionId, model, timestamp,
        tokens: {input, cacheWrite, cacheRead, output},
        sidechain: isSidechain === true,
        attribution,
        ...(project ? {project} : {}),
    };
}

/** Claude Code's own totals for a session, written to its transcript when it ends. */
export interface CostState {
    sessionId: string;
    models: Map<string, TokenCounts>;
    /** Claude Code's estimate at list price, per model and in total; absent if it wrote none. */
    modelCostUsd: Map<string, number>;
    totalCostUsd?: number;
    apiDurationMs?: number;
    linesAdded?: number;
    linesRemoved?: number;
}

function optionalCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
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
    const {type, sessionId, modelUsage, totalCostUSD, totalAPIDuration, totalLinesAdded, totalLinesRemoved} = entry as Record<string, unknown>;
    if (type !== 'cost-state' || typeof sessionId !== 'string' || typeof modelUsage !== 'object' || modelUsage === null)
        return null;

    const models = new Map<string, TokenCounts>();
    const modelCostUsd = new Map<string, number>();
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
        const cost = optionalCount(u.costUSD);
        if (cost !== undefined)
            modelCostUsd.set(model, cost);
    }

    const state: CostState = {sessionId, models, modelCostUsd};
    const total = optionalCount(totalCostUSD);
    const api = optionalCount(totalAPIDuration);
    const added = optionalCount(totalLinesAdded);
    const removed = optionalCount(totalLinesRemoved);
    if (total !== undefined)
        state.totalCostUsd = total;
    if (api !== undefined)
        state.apiDurationMs = api;
    if (added !== undefined)
        state.linesAdded = added;
    if (removed !== undefined)
        state.linesRemoved = removed;
    return state;
}

/** Which allowance a "You've hit your … limit" message is about. */
export type LimitWindow = 'session' | 'weekly' | 'other';

/** Claude Code's local message that a plan limit was reached. */
export interface LimitHit {
    window: LimitWindow;
    /** Unix epoch seconds of the message. */
    at: number;
    /** Unix epoch seconds of the reset, if the message names one Islet can read. */
    resetsAt?: number;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** UTC offset of `timeZone` at `epochMs`, in milliseconds (throws for an unknown zone). */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(epochMs));
    const get = (type: string) => Number(parts.find(part => part.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** The epoch milliseconds of a wall-clock time in `timeZone` (DST-aware to the hour). */
function zonedToEpochMs(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
    const guess = Date.UTC(year, month, day, hour, minute);
    const first = guess - zoneOffsetMs(guess, timeZone);
    return guess - zoneOffsetMs(first, timeZone);
}

/** The local calendar date of `epochMs` in `timeZone`. */
function zonedDate(epochMs: number, timeZone: string): {year: number; month: number; day: number} {
    const shifted = new Date(epochMs + zoneOffsetMs(epochMs, timeZone));
    return {year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate()};
}

/**
 * Reads the reset time of "… · resets 4:20pm (Europe/Berlin)" or "… · resets Oct 21, 10am
 * (Europe/Berlin)": the first such moment after `atMs`. Undefined if the text has another shape.
 */
export function parseResetTime(text: string, atMs: number): number | undefined {
    const match = /resets\s+(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
    if (!match)
        return undefined;
    const [, monthName, dayText, hourText, minuteText, meridiem, timeZone] = match;
    const clockHour = Number(hourText);
    const minute = minuteText ? Number(minuteText) : 0;
    if (clockHour < 1 || clockHour > 12 || minute > 59)
        return undefined;
    const hour = clockHour % 12 + (meridiem.toLowerCase() === 'pm' ? 12 : 0);

    try {
        if (monthName) {
            const month = MONTHS.indexOf(monthName.toLowerCase());
            if (month < 0)
                return undefined;
            const {year} = zonedDate(atMs, timeZone);
            for (const candidateYear of [year, year + 1]) {
                const ms = zonedToEpochMs(candidateYear, month, Number(dayText), hour, minute, timeZone);
                if (ms > atMs)
                    return Math.floor(ms / 1000);
            }
            return undefined;
        }
        // Only a time: today in that zone, or tomorrow if it has already passed.
        for (let days = 0; days <= 1; days++) {
            const {year, month, day} = zonedDate(atMs + days * 86_400_000, timeZone);
            const ms = zonedToEpochMs(year, month, day, hour, minute, timeZone);
            if (ms > atMs)
                return Math.floor(ms / 1000);
        }
    } catch {
        return undefined; // Unknown time zone.
    }
    return undefined;
}

/**
 * Reads a usage-limit message: a synthetic assistant line with `error: "rate_limit"` and
 * `apiError: "usage_limit_reached"`. Only that line's text is read, which Claude Code writes
 * itself ("You've hit your session limit · resets 4:20pm (Europe/Berlin)").
 */
export function parseLimitLine(line: string): LimitHit | null {
    if (!line.includes('usage_limit_reached'))
        return null;
    let entry: unknown;
    try {
        entry = JSON.parse(line);
    } catch {
        return null;
    }
    if (typeof entry !== 'object' || entry === null)
        return null;
    const {type, apiError, timestamp, message} = entry as Record<string, unknown>;
    if (type !== 'assistant' || apiError !== 'usage_limit_reached' || typeof timestamp !== 'string')
        return null;
    const atMs = Date.parse(timestamp);
    if (Number.isNaN(atMs))
        return null;

    const content = typeof message === 'object' && message !== null ? (message as Record<string, unknown>).content : undefined;
    const text = Array.isArray(content)
        ? content.map(block => typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>).text === 'string'
            ? (block as Record<string, string>).text : '').join(' ')
        : '';
    const lower = text.toLowerCase();
    const window: LimitWindow = lower.includes('session limit') ? 'session' : lower.includes('weekly limit') ? 'weekly' : 'other';
    const resetsAt = parseResetTime(text, atMs);
    return {window, at: Math.floor(atMs / 1000), ...(resetsAt !== undefined ? {resetsAt} : {})};
}

/**
 * Cheap pre-check before JSON.parse: transcripts are mostly conversation content, and only
 * assistant responses with usage and cost-state entries matter.
 */
export function mayHoldUsage(line: string): boolean {
    return (line.includes('"usage"') && line.includes('"assistant"')) || line.includes('"cost-state"') ||
        line.includes('usage_limit_reached');
}

/** Input + cache write + output: the new work of a response. */
export function freshTokens(tokens: TokenCounts): number {
    return tokens.input + tokens.cacheWrite + tokens.output;
}

/** Fresh + cache read: everything the model processed. */
export function processedTokens(tokens: TokenCounts): number {
    return freshTokens(tokens) + tokens.cacheRead;
}
