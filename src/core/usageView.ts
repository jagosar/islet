// SPDX-License-Identifier: GPL-2.0-or-later

/** Formatting for the Usage view, kept pure so it is unit tested. */
import {formatTokens} from './format.js';
import type {AttributionKind, FlagId, SessionSummary} from './usage/insights.js';

type Translate = (text: string) => string;
const identity: Translate = text => text;

/** "claude-opus-5-5" -> "Opus 5.5", "claude-haiku-4-5-20251001" -> "Haiku 4.5"; other ids unchanged. */
export function modelLabel(model: string): string {
    const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
    if (!match)
        return model;
    const [, family, major, minor] = match;
    return `${family[0].toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`;
}

/** "$0.04", "$12.30", "$1,234" — dollars as Claude Code shows them. */
export function formatUsd(value: number): string {
    if (value >= 1000)
        return `$${Math.round(value).toLocaleString('en-US')}`;
    return `$${value.toFixed(2)}`;
}

/** A share (0 to 1) as "79%", or "<1%" for a small non-zero one. */
export function formatShare(share: number): string {
    if (share > 0 && share < 0.005)
        return '<1%';
    return `${Math.round(share * 100)}%`;
}

export function flagLabel(id: FlagId, t: Translate = identity): string {
    switch (id) {
    case 'long-context':
        return t('ran with more than 150k tokens of context');
    case 'long-session':
        return t('came from sessions active for more than 8 hours');
    case 'parallel':
        return t('ran while 4 or more sessions were active');
    case 'always-on-context':
        return t('always-on context (system prompt, tools, CLAUDE.md)');
    case 'cache-miss':
        return t('re-sent context after a cache miss');
    }
}

export function attributionKindLabel(kind: AttributionKind, t: Translate = identity): string {
    switch (kind) {
    case 'mcp':
        return t('MCP');
    case 'skill':
        return t('Skill');
    case 'agent':
        return t('Subagent');
    case 'plugin':
        return t('Plugin');
    }
}

/** Skills are shown as the command that runs them, like Claude Code does. */
export function attributionName(kind: AttributionKind, name: string): string {
    return kind === 'skill' ? `/${name}` : name;
}

export interface BreakdownTable {
    /** Column headings: up to two models, then "Total". */
    columns: string[];
    /** Row label and one cell per column. */
    rows: {label: string; cells: string[]}[];
}

/**
 * The session's tokens and cost per model, like the desktop app's "Breakdown": the two
 * costliest models and a total (which also includes any others).
 */
export function breakdownTable(session: SessionSummary, t: Translate = identity): BreakdownTable {
    const shown = session.models.slice(0, 2);
    const sum = (pick: (m: SessionSummary['models'][number]) => number) => session.models.reduce((total, m) => total + pick(m), 0);
    const row = (label: string, pick: (m: SessionSummary['models'][number]) => number, format: (n: number) => string) => ({
        label,
        cells: [...shown.map(m => format(pick(m))), format(sum(pick))],
    });
    return {
        columns: [...shown.map(m => modelLabel(m.model)), t('Total')],
        rows: [
            row(t('Input'), m => m.tokens.input, formatTokens),
            row(t('Output'), m => m.tokens.output, formatTokens),
            row(t('Cache read'), m => m.tokens.cacheRead, formatTokens),
            row(t('Cache write'), m => m.tokens.cacheWrite, formatTokens),
            row(t('Cost'), m => m.usd, formatUsd),
        ],
    };
}

/** "Opus 97% · Sonnet 3%": the session's models by share of cost. */
export function modelMix(session: SessionSummary): string {
    return session.models
        .filter(m => m.share > 0)
        .map(m => `${modelLabel(m.model)} ${formatShare(m.share)}`)
        .join(' · ');
}
