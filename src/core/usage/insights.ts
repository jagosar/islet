// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * What is using your plan limits: the same questions Claude Code's `/usage` breakdown answers,
 * computed from local transcripts.
 *
 * Like `/usage`, the figures are approximate, cover this computer only (not claude.ai or other
 * devices) and overlap: one request can be long-context, from a subagent and from an MCP server
 * at the same time. Each request is weighted by its estimated cost (see `requestWeight`), so a
 * cache read counts far less than an output token.
 */
import type {Attribution, CostState, TokenCounts, UsageRecord} from './claudeTranscript.js';

/** Public list prices in USD per million input tokens, by model family (Claude 4.5 generation). */
const FAMILY_INPUT_USD_PER_MTOK: [RegExp, number][] = [
    [/opus/i, 5],
    [/sonnet/i, 3],
    [/haiku/i, 1],
];
/** Used for a model whose family Islet does not recognise. */
const DEFAULT_INPUT_USD_PER_MTOK = 3;
/** Price of each token type relative to input, as Anthropic's pricing defines it. */
const RATE = {input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5} as const;

export const DAY_SECONDS = 86_400;
export const WEEK_SECONDS = 7 * DAY_SECONDS;
/** A request with more context than this counts as long-context (Claude Code uses the same bar). */
export const LONG_CONTEXT_TOKENS = 150_000;
/** A session that has been running longer than this at a request counts as a long session. */
export const LONG_SESSION_SECONDS = 8 * 3600;
/** At least this many sessions active together count as parallel work. */
export const PARALLEL_SESSIONS = 4;
/** A session is active at a moment if it made a request in the window before it. */
export const ACTIVE_WINDOW_SECONDS = 10 * 60;
/** Gaps between requests shorter than this count as active time. */
export const ACTIVE_GAP_SECONDS = 5 * 60;
/** Behaviours are shown when they account for at least this share of usage (as in `/usage`). */
export const FLAG_THRESHOLD = 0.1;
/** Attribution rows below this share are left out. */
export const ATTRIBUTION_THRESHOLD = 0.01;
export const MAX_ATTRIBUTION_ROWS = 6;

export type AttributionKind = 'mcp' | 'skill' | 'agent' | 'plugin';
export type FlagId = 'long-context' | 'long-session' | 'parallel' | 'always-on-context' | 'cache-miss';

export interface AttributionShare {
    kind: AttributionKind;
    name: string;
    /** 0 to 1. */
    share: number;
}

export interface FlagShare {
    id: FlagId;
    share: number;
}

export interface InsightsWindow {
    /** Number of requests in the window. */
    requests: number;
    /** Estimated cost at list price of all requests in the window, USD. */
    estimatedUsd: number;
    attribution: AttributionShare[];
    flags: FlagShare[];
}

export interface SessionModel {
    model: string;
    tokens: TokenCounts;
    /** Share of the session's estimated cost, 0 to 1. */
    share: number;
    usd: number;
}

export interface SessionSummary {
    sessionId: string;
    project: string;
    /** Unix epoch seconds of the first and the latest request Islet saw. */
    startedAt: number;
    lastAt: number;
    /** Time with requests no more than ACTIVE_GAP_SECONDS apart, in seconds. */
    activeSeconds: number;
    requests: number;
    models: SessionModel[];
    usd: number;
    /** True when `usd` and the models come from Claude Code's own totals for the session. */
    exact: boolean;
    /** Share of input tokens served from the prompt cache, 0 to 1. */
    cacheHitRatio: number;
    apiSeconds?: number;
    linesAdded?: number;
    linesRemoved?: number;
}

export interface Insights {
    /** Unix epoch seconds the figures were computed at. */
    generatedAt: number;
    day: InsightsWindow;
    week: InsightsWindow;
    session: SessionSummary | null;
}

/** The part of a response Islet keeps for a week. */
interface Sample {
    at: number;
    sessionId: string;
    model: string;
    tokens: TokenCounts;
    sidechain: boolean;
    attribution: Attribution;
    project?: string;
}


function inputUsdPerMTok(model: string): number {
    return FAMILY_INPUT_USD_PER_MTOK.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_INPUT_USD_PER_MTOK;
}

/** Tokens the request sent to the model: new input, cache writes and cache reads. */
export function contextTokens(tokens: TokenCounts): number {
    return tokens.input + tokens.cacheWrite + tokens.cacheRead;
}

/** Estimated cost of a response in USD, at public list prices for its model family. */
export function requestWeight(model: string, tokens: TokenCounts): number {
    const weighted = tokens.input * RATE.input + tokens.cacheWrite * RATE.cacheWrite +
        tokens.cacheRead * RATE.cacheRead + tokens.output * RATE.output;
    return weighted * inputUsdPerMTok(model) / 1_000_000;
}

/** Cost of `count` tokens read from the cache, for the "always-on context" estimate. */
function cacheReadWeight(model: string, count: number): number {
    return count * RATE.cacheRead * inputUsdPerMTok(model) / 1_000_000;
}

function addTokens(target: TokenCounts, tokens: TokenCounts): void {
    target.input += tokens.input;
    target.cacheWrite += tokens.cacheWrite;
    target.cacheRead += tokens.cacheRead;
    target.output += tokens.output;
}

const ATTRIBUTION_FIELDS: [keyof Attribution, AttributionKind][] = [
    ['mcpServer', 'mcp'], ['skill', 'skill'], ['agent', 'agent'], ['plugin', 'plugin'],
];

/**
 * Keeps a week of responses (deduplicated by the caller) and computes Insights on demand.
 * Memory is bounded by prune(): a sample is a few hundred bytes, and a busy week is thousands.
 */
export class InsightsCollector {
    private samples: Sample[] = [];
    private sorted = true;
    private readonly costStates = new Map<string, CostState>();

    /** `clock` returns Unix epoch seconds; tests pass a fixed one. */
    constructor(private readonly clock: () => number = () => Date.now() / 1000) {}

    /**
     * Adds a response counted for the first time. Responses older than the week (plus a day of
     * margin) are not kept: the daemon's first scan reads 26 weeks of transcripts.
     */
    add(record: UsageRecord): void {
        const at = Math.floor(Date.parse(record.timestamp) / 1000);
        if (!Number.isFinite(at) || at < this.clock() - WEEK_SECONDS - DAY_SECONDS)
            return;
        const last = this.samples.at(-1);
        if (last && at < last.at)
            this.sorted = false;
        this.samples.push({
            at, sessionId: record.sessionId, model: record.model, tokens: {...record.tokens},
            sidechain: record.sidechain, attribution: record.attribution,
            ...(record.project ? {project: record.project} : {}),
        });
    }

    /** Claude Code's own totals for a session (its latest `cost-state`). */
    setCostState(state: CostState): void {
        this.costStates.set(state.sessionId, state);
    }

    /** Forgets responses older than a week before `now`, and totals of sessions with none left. */
    prune(now: number): void {
        const cutoff = now - WEEK_SECONDS;
        this.samples = this.samples.filter(sample => sample.at > cutoff);
        const live = new Set(this.samples.map(sample => sample.sessionId));
        for (const id of this.costStates.keys()) {
            if (!live.has(id))
                this.costStates.delete(id);
        }
    }

    get size(): number {
        return this.samples.length;
    }

    build(now: number): Insights {
        if (!this.sorted) {
            this.samples.sort((a, b) => a.at - b.at);
            this.sorted = true;
        }
        return {
            generatedAt: now,
            day: buildWindow(this.samples, now - DAY_SECONDS, now),
            week: buildWindow(this.samples, now - WEEK_SECONDS, now),
            session: buildSession(this.samples, this.costStates),
        };
    }
}

/** Per-session facts the flags need: when the session started and its first main-thread context. */
interface SessionFacts {
    startedAt: number;
    baseline: number | null;
    lastContext: Map<string, number>;
}

/** `samples` must be sorted by time. */
export function buildWindow(samples: readonly Sample[], from: number, to: number): InsightsWindow {
    const facts = new Map<string, SessionFacts>();
    const attribution = new Map<string, {kind: AttributionKind; name: string; weight: number}>();
    const flagWeights: Record<FlagId, number> = {
        'long-context': 0, 'long-session': 0, 'parallel': 0, 'always-on-context': 0, 'cache-miss': 0,
    };
    // Latest request time of each session, for the parallel-sessions test.
    const lastSeen = new Map<string, number>();
    let total = 0;
    let requests = 0;

    for (const sample of samples) {
        if (sample.at > to)
            break;
        // Session facts are gathered from everything kept, also before the window, so a
        // session that started yesterday is still known to be long today.
        let session = facts.get(sample.sessionId);
        if (!session) {
            session = {startedAt: sample.at, baseline: null, lastContext: new Map()};
            facts.set(sample.sessionId, session);
        }
        lastSeen.set(sample.sessionId, sample.at);
        const context = contextTokens(sample.tokens);
        const previousContext = session.lastContext.get(sample.model);
        if (!sample.sidechain) {
            session.lastContext.set(sample.model, context);
            session.baseline ??= context;
        }

        if (sample.at <= from)
            continue;

        const weight = requestWeight(sample.model, sample.tokens);
        total += weight;
        requests++;

        for (const [field, kind] of ATTRIBUTION_FIELDS) {
            const name = sample.attribution[field];
            if (!name)
                continue;
            const key = `${kind}\u0000${name}`;
            const row = attribution.get(key) ?? {kind, name, weight: 0};
            row.weight += weight;
            attribution.set(key, row);
        }

        if (context > LONG_CONTEXT_TOKENS)
            flagWeights['long-context'] += weight;
        if (sample.at - session.startedAt > LONG_SESSION_SECONDS)
            flagWeights['long-session'] += weight;

        let active = 0;
        for (const seen of lastSeen.values()) {
            if (sample.at - seen <= ACTIVE_WINDOW_SECONDS)
                active++;
        }
        if (active >= PARALLEL_SESSIONS)
            flagWeights.parallel += weight;

        if (!sample.sidechain && session.baseline !== null)
            flagWeights['always-on-context'] += Math.min(weight, cacheReadWeight(sample.model, Math.min(context, session.baseline)));

        // A request that had to write most of its context to the cache again, although the
        // conversation already had a cached prefix: the cache had expired or been invalidated.
        if (!sample.sidechain && previousContext !== undefined && context >= 20_000 && sample.tokens.cacheWrite >= context / 2)
            flagWeights['cache-miss'] += weight;
    }

    const share = (weight: number) => (total > 0 ? weight / total : 0);
    return {
        requests,
        estimatedUsd: total,
        attribution: [...attribution.values()]
            .map(row => ({kind: row.kind, name: row.name, share: share(row.weight)}))
            .filter(row => row.share >= ATTRIBUTION_THRESHOLD)
            .sort((a, b) => b.share - a.share || a.name.localeCompare(b.name))
            .slice(0, MAX_ATTRIBUTION_ROWS),
        flags: (Object.keys(flagWeights) as FlagId[])
            .map(id => ({id, share: share(flagWeights[id])}))
            .filter(flag => flag.share >= FLAG_THRESHOLD)
            .sort((a, b) => b.share - a.share),
    };
}

/** The session of the latest main-thread request, or null without one. `samples` sorted by time. */
export function buildSession(samples: readonly Sample[], costStates: ReadonlyMap<string, CostState>): SessionSummary | null {
    const latest = samples.findLast(sample => !sample.sidechain);
    if (!latest)
        return null;
    const own = samples.filter(sample => sample.sessionId === latest.sessionId);

    const byModel = new Map<string, {tokens: TokenCounts; usd: number}>();
    let activeSeconds = 0;
    let project = '';
    own.forEach((sample, i) => {
        const row = byModel.get(sample.model) ?? {tokens: {input: 0, cacheWrite: 0, cacheRead: 0, output: 0}, usd: 0};
        addTokens(row.tokens, sample.tokens);
        row.usd += requestWeight(sample.model, sample.tokens);
        byModel.set(sample.model, row);
        if (i > 0) {
            const gap = sample.at - own[i - 1].at;
            if (gap <= ACTIVE_GAP_SECONDS)
                activeSeconds += gap;
        }
        if (sample.project && !sample.sidechain)
            project = sample.project;
    });

    // Claude Code's own totals win while they cover at least what the transcript shows (it
    // writes them when a session ends; a resumed session goes on past them).
    const state = costStates.get(latest.sessionId);
    const exact = Boolean(state && state.modelCostUsd.size > 0 && [...byModel].every(([model, row]) => {
        const reference = state.models.get(model);
        return reference !== undefined && reference.output >= row.tokens.output;
    }));
    if (exact && state) {
        byModel.clear();
        for (const [model, tokens] of state.models)
            byModel.set(model, {tokens: {...tokens}, usd: state.modelCostUsd.get(model) ?? requestWeight(model, tokens)});
    }

    const usd = exact && state?.totalCostUsd !== undefined
        ? state.totalCostUsd
        : [...byModel.values()].reduce((sum, row) => sum + row.usd, 0);
    const modelsUsd = [...byModel.values()].reduce((sum, row) => sum + row.usd, 0);
    const all: TokenCounts = {input: 0, cacheWrite: 0, cacheRead: 0, output: 0};
    for (const row of byModel.values())
        addTokens(all, row.tokens);
    const inputSide = contextTokens(all);

    const summary: SessionSummary = {
        sessionId: latest.sessionId,
        project,
        startedAt: own[0].at,
        lastAt: own[own.length - 1].at,
        activeSeconds,
        requests: own.length,
        models: [...byModel]
            .map(([model, row]) => ({model, tokens: row.tokens, usd: row.usd, share: modelsUsd > 0 ? row.usd / modelsUsd : 0}))
            .sort((a, b) => b.usd - a.usd),
        usd,
        exact,
        cacheHitRatio: inputSide > 0 ? all.cacheRead / inputSide : 0,
    };
    if (exact && state) {
        if (state.apiDurationMs !== undefined)
            summary.apiSeconds = Math.round(state.apiDurationMs / 1000);
        if (state.linesAdded !== undefined)
            summary.linesAdded = state.linesAdded;
        if (state.linesRemoved !== undefined)
            summary.linesRemoved = state.linesRemoved;
    }
    return summary;
}
