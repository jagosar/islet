/**
 * The documents behind the D-Bus properties of io.github.jagosar.Islet1.
 *
 * Each property is a JSON string with a `version` field. Both sides validate with the decoders
 * below, so a malformed or newer document becomes "no data" instead of an error in the Shell.
 */
import type {TokenCounts} from './usage/claudeTranscript.js';

export const PROTOCOL_VERSION = 1;

export interface PlanWindow {
    /** 0 to 100. */
    usedPercentage: number;
    /** Unix epoch seconds. */
    resetsAt: number;
}

export interface PlanUsage {
    fiveHour?: PlanWindow;
    sevenDay?: PlanWindow;
    /** Unix epoch seconds when the daemon received the figures. */
    measuredAt: number;
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
    if (!isObject(value) || !isCount(value.usedPercentage) || value.usedPercentage > 100 || !isCount(value.resetsAt))
        return null;
    return {usedPercentage: value.usedPercentage, resetsAt: value.resetsAt};
}

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
    return {
        measuredAt: plan.measuredAt,
        ...(fiveHour ? {fiveHour} : {}),
        ...(sevenDay ? {sevenDay} : {}),
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
    return {measuredAt: now, ...(fiveHour ? {fiveHour} : {}), ...(sevenDay ? {sevenDay} : {})};
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
