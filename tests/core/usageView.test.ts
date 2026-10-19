// SPDX-License-Identifier: GPL-2.0-or-later
import {describe, expect, it} from 'vitest';
import type {SessionSummary} from '../../src/core/usage/insights.js';
import {
    attributionKindLabel, attributionName, breakdownTable, flagLabel, formatShare, formatUsd, modelLabel, modelMix,
} from '../../src/core/usageView.js';

const tokens = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({input, output, cacheRead, cacheWrite});

const session: SessionSummary = {
    sessionId: 's', project: 'islet', startedAt: 0, lastAt: 0, activeSeconds: 0, requests: 3, usd: 86.5, exact: true, cacheHitRatio: 0.99,
    models: [
        {model: 'claude-opus-5-5', tokens: tokens(1100, 21_400, 246_600_000, 2_300_000), share: 0.97, usd: 84.12},
        {model: 'claude-sonnet-5-5', tokens: tokens(8, 23, 1_700_000, 512_000), share: 0.027, usd: 2.36},
        {model: 'claude-haiku-5-5', tokens: tokens(1, 1, 1, 1), share: 0.0002, usd: 0.02},
    ],
};

describe('modelLabel', () => {
    it.each([
        ['claude-opus-5-5', 'Opus 5.5'],
        ['claude-sonnet-5', 'Sonnet 5'],
        ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
        ['claude-fable-5-1', 'Fable 5.1'],
        ['gpt-x', 'gpt-x'],
    ])('%s -> %s', (model, label) => {
        expect(modelLabel(model)).toBe(label);
    });
});

describe('formatting', () => {
    it.each([[0.04, '$0.04'], [86.495, '$86.50'], [1234.4, '$1,234']])('formatUsd(%d) = %s', (value, text) => {
        expect(formatUsd(value)).toBe(text);
    });

    it.each([[0, '0%'], [0.004, '<1%'], [0.005, '1%'], [0.79, '79%'], [1, '100%']])('formatShare(%d) = %s', (share, text) => {
        expect(formatShare(share)).toBe(text);
    });

    it('labels every behaviour and attribution kind', () => {
        for (const id of ['long-context', 'long-session', 'parallel', 'always-on-context', 'cache-miss'] as const)
            expect(flagLabel(id)).toMatch(/\w/);
        expect(['mcp', 'skill', 'agent', 'plugin'].map(k => attributionKindLabel(k as 'mcp'))).toEqual(['MCP', 'Skill', 'Subagent', 'Plugin']);
    });

    it('shows skills as their command', () => {
        expect(attributionName('skill', 'architect')).toBe('/architect');
        expect(attributionName('mcp', 'ccd_turn')).toBe('ccd_turn');
    });
});

describe('breakdownTable', () => {
    it('shows the two costliest models and a total that includes the rest', () => {
        expect(breakdownTable(session)).toEqual({
            columns: ['Opus 5.5', 'Sonnet 5.5', 'Total'],
            rows: [
                {label: 'Input', cells: ['1.10K', '8', '1.11K']},
                {label: 'Output', cells: ['21.4K', '23', '21.4K']},
                {label: 'Cache read', cells: ['247M', '1.70M', '248M']},
                {label: 'Cache write', cells: ['2.30M', '512K', '2.81M']},
                {label: 'Cost', cells: ['$84.12', '$2.36', '$86.50']},
            ],
        });
    });

    it('lists models by share in the mix, without empty ones', () => {
        expect(modelMix({...session, models: [...session.models, {model: 'm', tokens: tokens(0, 0, 0, 0), share: 0, usd: 0}]}))
            .toBe('Opus 5.5 97% · Sonnet 5.5 3% · Haiku 5.5 <1%');
    });
});
