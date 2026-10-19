// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * The documents behind the D-Bus properties of io.github.jagosar.Islet1.
 *
 * Each property is a JSON string with a `version` field. Both sides validate with the decoders
 * below, so a malformed or newer document becomes "no data" instead of an error in the Shell.
 */
import type {TokenCounts} from './usage/claudeTranscript.js';
import type {
    AttributionKind, AttributionShare, FlagId, FlagShare, Insights, InsightsWindow, SessionModel, SessionSummary,
} from './usage/insights.js';

export const PROTOCOL_VERSION = 1;

export interface PlanWindow {
    /** 0 to 100. */
    usedPercentage: number;
    /** Unix epoch seconds; absent when the source does not say (the desktop app's history). */
    resetsAt?: number;
}

/** Where the latest plan figures came from. */
export type PlanSource = 'statusline' | 'desktop' | 'limit';

export interface PlanUsage {
    fiveHour?: PlanWindow;
    sevenDay?: PlanWindow;
    /** Unix epoch seconds when the figures were measured. */
    measuredAt: number;
    source?: PlanSource;
}

/**
 * A guess of where the 5-hour window is now, between two measurements: the last measured figure
 * plus what the transcripts say was used since. It always belongs to one reading (`basedOn` is
 * that reading's `measuredAt`) and is never saved.
 */
export interface PlanEstimate {
    /** 0 to 100, above the measured figure. */
    fiveHour: number;
    /** `measuredAt` of the reading it extends. */
    basedOn: number;
    /** Unix epoch seconds it was computed at. */
    at: number;
}

export interface DayUsage {
    /** YYYY-MM-DD, local day. */
    day: string;
    models: Record<string, TokenCounts>;
}

export interface UsageSnapshot {
    today: DayUsage | null;
    /** Fresh tokens per day, oldest first. */
    history: {day: string; fresh: number}[];
}

export type SessionState = 'working' | 'needs-permission' | 'waiting' | 'finished' | 'idle';

export interface AgentSession {
    sessionId: string;
    project: string;
    state: SessionState;
    /** Unix epoch seconds when the session entered `state`. */
    since: number;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isDay(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Parses a versioned document; null unless it is an object of this protocol version. */
function parseDocument(text: string): Json | null {
    let document: unknown;
    try {
        document = JSON.parse(text);
    } catch {
        return null;
    }
    return isObject(document) && document.version === PROTOCOL_VERSION ? document : null;
}

function encode(document: object): string {
    return JSON.stringify({version: PROTOCOL_VERSION, ...document});
}

function decodeWindow(value: unknown): PlanWindow | undefined | null {
    if (value === undefined)
        return undefined;
    if (!isObject(value) || !isCount(value.usedPercentage) || value.usedPercentage > 100)
        return null;
    if (value.resetsAt === undefined)
        return {usedPercentage: value.usedPercentage};
    return isCount(value.resetsAt) ? {usedPercentage: value.usedPercentage, resetsAt: value.resetsAt} : null;
}

const PLAN_SOURCES: readonly PlanSource[] = ['statusline', 'desktop', 'limit'];

export function encodePlanUsage(plan: PlanUsage | null): string {
    return encode({plan});
}

export function decodePlanUsage(text: string): PlanUsage | null {
    const plan = parseDocument(text)?.plan;
    if (!isObject(plan) || !isCount(plan.measuredAt))
        return null;
    const fiveHour = decodeWindow(plan.fiveHour);
    const sevenDay = decodeWindow(plan.sevenDay);
    if (fiveHour === null || sevenDay === null || (!fiveHour && !sevenDay))
        return null;
    if (plan.source !== undefined && !PLAN_SOURCES.includes(plan.source as PlanSource))
        return null;
    return {
        measuredAt: plan.measuredAt,
        ...(fiveHour ? {fiveHour} : {}),
        ...(sevenDay ? {sevenDay} : {}),
        ...(plan.source !== undefined ? {source: plan.source as PlanSource} : {}),
    };
}

/**
 * Validates the figures the status line bridge reports (method ReportPlanUsage). Keys are
 * `five_hour_used_percentage`, `five_hour_resets_at`, `seven_day_used_percentage` and
 * `seven_day_resets_at`; a window needs both of its keys. Null if no window is valid.
 */
export function parsePlanUsageReport(fields: Record<string, number>, now: number): PlanUsage | null {
    const window = (prefix: string): PlanWindow | undefined => {
        const usedPercentage = fields[`${prefix}_used_percentage`];
        const resetsAt = fields[`${prefix}_resets_at`];
        return isCount(usedPercentage) && usedPercentage <= 100 && isCount(resetsAt)
            ? {usedPercentage, resetsAt}
            : undefined;
    };
    const fiveHour = window('five_hour');
    const sevenDay = window('seven_day');
    if (!fiveHour && !sevenDay)
        return null;
    return {measuredAt: now, source: 'statusline', ...(fiveHour ? {fiveHour} : {}), ...(sevenDay ? {sevenDay} : {})};
}

function decodeTokens(value: unknown): TokenCounts | null {
    if (!isObject(value))
        return null;
    const {input, cacheWrite, cacheRead, output} = value;
    return isCount(input) && isCount(cacheWrite) && isCount(cacheRead) && isCount(output)
        ? {input, cacheWrite, cacheRead, output}
        : null;
}

export function encodeUsage(usage: UsageSnapshot): string {
    return encode({usage});
}

export function decodeUsage(text: string): UsageSnapshot | null {
    const usage = parseDocument(text)?.usage;
    if (!isObject(usage) || !Array.isArray(usage.history))
        return null;

    let today: DayUsage | null = null;
    if (usage.today !== null) {
        if (!isObject(usage.today) || !isDay(usage.today.day) || !isObject(usage.today.models))
            return null;
        const models: Record<string, TokenCounts> = {};
        for (const [model, tokens] of Object.entries(usage.today.models)) {
            const decoded = decodeTokens(tokens);
            if (!decoded)
                return null;
            models[model] = decoded;
        }
        today = {day: usage.today.day, models};
    }

    const history: UsageSnapshot['history'] = [];
    for (const entry of usage.history) {
        if (!isObject(entry) || !isDay(entry.day) || !isCount(entry.fresh))
            return null;
        history.push({day: entry.day, fresh: entry.fresh});
    }
    return {today, history};
}

const SESSION_STATES: readonly SessionState[] = ['working', 'needs-permission', 'waiting', 'finished', 'idle'];

export function encodeSessions(sessions: AgentSession[]): string {
    return encode({sessions});
}

export function decodeSessions(text: string): AgentSession[] | null {
    const sessions = parseDocument(text)?.sessions;
    if (!Array.isArray(sessions))
        return null;
    const decoded: AgentSession[] = [];
    for (const session of sessions) {
        if (!isObject(session) || typeof session.sessionId !== 'string' || typeof session.project !== 'string' ||
            !SESSION_STATES.includes(session.state as SessionState) || !isCount(session.since))
            return null;
        decoded.push({sessionId: session.sessionId, project: session.project, state: session.state as SessionState, since: session.since});
    }
    return decoded;
}

export function encodeInsights(insights: Insights | null): string {
    return encode({insights});
}

const ATTRIBUTION_KINDS: readonly AttributionKind[] = ['mcp', 'skill', 'agent', 'plugin'];
const FLAG_IDS: readonly FlagId[] = ['long-context', 'long-session', 'parallel', 'always-on-context', 'cache-miss'];

function isShare(value: unknown): value is number {
    return isCount(value) && value <= 1;
}

function decodeInsightsWindow(value: unknown): InsightsWindow | null {
    if (!isObject(value) || !isCount(value.requests) || !isCount(value.estimatedUsd) ||
        !Array.isArray(value.attribution) || !Array.isArray(value.flags))
        return null;
    const attribution: AttributionShare[] = [];
    for (const row of value.attribution) {
        if (!isObject(row) || !ATTRIBUTION_KINDS.includes(row.kind as AttributionKind) ||
            typeof row.name !== 'string' || !isShare(row.share))
            return null;
        attribution.push({kind: row.kind as AttributionKind, name: row.name, share: row.share});
    }
    const flags: FlagShare[] = [];
    for (const flag of value.flags) {
        if (!isObject(flag) || !FLAG_IDS.includes(flag.id as FlagId) || !isShare(flag.share))
            return null;
        flags.push({id: flag.id as FlagId, share: flag.share});
    }
    return {requests: value.requests, estimatedUsd: value.estimatedUsd, attribution, flags};
}

function decodeSession(value: unknown): SessionSummary | null | undefined {
    if (value === null)
        return undefined;
    if (!isObject(value) || typeof value.sessionId !== 'string' || typeof value.project !== 'string' ||
        !isCount(value.startedAt) || !isCount(value.lastAt) || !isCount(value.activeSeconds) ||
        !isCount(value.requests) || !Array.isArray(value.models) || !isCount(value.usd) ||
        typeof value.exact !== 'boolean' || !isShare(value.cacheHitRatio))
        return null;
    const models: SessionModel[] = [];
    for (const row of value.models) {
        if (!isObject(row) || typeof row.model !== 'string' || !isShare(row.share) || !isCount(row.usd))
            return null;
        const tokens = decodeTokens(row.tokens);
        if (!tokens)
            return null;
        models.push({model: row.model, tokens, share: row.share, usd: row.usd});
    }
    const summary: SessionSummary = {
        sessionId: value.sessionId, project: value.project, startedAt: value.startedAt, lastAt: value.lastAt,
        activeSeconds: value.activeSeconds, requests: value.requests, models, usd: value.usd,
        exact: value.exact, cacheHitRatio: value.cacheHitRatio,
    };
    for (const key of ['apiSeconds', 'linesAdded', 'linesRemoved'] as const) {
        const field = value[key];
        if (field === undefined)
            continue;
        if (!isCount(field))
            return null;
        summary[key] = field;
    }
    return summary;
}

export function decodeInsights(text: string): Insights | null {
    const insights = parseDocument(text)?.insights;
    if (!isObject(insights) || !isCount(insights.generatedAt))
        return null;
    const day = decodeInsightsWindow(insights.day);
    const week = decodeInsightsWindow(insights.week);
    const session = decodeSession(insights.session);
    if (!day || !week || session === null)
        return null;
    return {generatedAt: insights.generatedAt, day, week, session: session ?? null};
}

export function encodePlanEstimate(estimate: PlanEstimate | null): string {
    return encode({estimate});
}

export function decodePlanEstimate(text: string): PlanEstimate | null {
    const estimate = parseDocument(text)?.estimate;
    if (!isObject(estimate) || !isCount(estimate.fiveHour) || estimate.fiveHour > 100 ||
        !isCount(estimate.basedOn) || !isCount(estimate.at))
        return null;
    return {fiveHour: estimate.fiveHour, basedOn: estimate.basedOn, at: estimate.at};
}
