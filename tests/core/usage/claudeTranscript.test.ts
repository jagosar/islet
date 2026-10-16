import {describe, expect, it} from 'vitest';
import {freshTokens, mayHoldUsage, parseCostStateLine, parseUsageLine, processedTokens} from '../../../src/core/usage/claudeTranscript.js';

function assistantLine(overrides: Record<string, unknown> = {}, message: Record<string, unknown> = {}, usage: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'assistant',
        sessionId: 's1',
        timestamp: '2026-10-16T10:45:08.793Z',
        message: {
            id: 'msg_1',
            model: 'claude-haiku-5-5',
            content: [{type: 'text', text: 'never read'}],
            usage: {
                input_tokens: 2,
                cache_creation_input_tokens: 30057,
                cache_read_input_tokens: 39206,
                output_tokens: 521,
                output_tokens_details: {thinking_tokens: 183},
                service_tier: 'standard',
                ...usage,
            },
            ...message,
        },
        ...overrides,
    });
}

describe('parseUsageLine', () => {
    it('reads the usage of an assistant response', () => {
        expect(parseUsageLine(assistantLine())).toEqual({
            messageId: 'msg_1',
            sessionId: 's1',
            model: 'claude-haiku-5-5',
            timestamp: '2026-10-16T10:45:08.793Z',
            tokens: {input: 2, cacheWrite: 30057, cacheRead: 39206, output: 521},
        });
    });

    it('treats missing counts as zero', () => {
        expect(parseUsageLine(assistantLine({}, {usage: {output_tokens: 5}}))?.tokens)
            .toEqual({input: 0, cacheWrite: 0, cacheRead: 0, output: 5});
    });

    it.each([
        ['a user line', JSON.stringify({type: 'user', message: {content: 'hi'}})],
        ['a synthetic message', assistantLine({}, {model: '<synthetic>'})],
        ['a message without id', assistantLine({}, {id: undefined})],
        ['a message without usage', assistantLine({}, {usage: undefined})],
        ['a line without session', assistantLine({sessionId: undefined})],
        ['an invalid timestamp', assistantLine({timestamp: 'yesterday'})],
        ['a negative count', assistantLine({}, {}, {output_tokens: -1})],
        ['a non-numeric count', assistantLine({}, {}, {input_tokens: '12'})],
        ['a truncated last line', assistantLine().slice(0, 80)],
        ['an empty line', ''],
        ['a JSON array', '[]'],
    ])('ignores %s', (_name, line) => {
        expect(parseUsageLine(line)).toBeNull();
    });
});

describe('parseCostStateLine', () => {
    const line = JSON.stringify({
        type: 'cost-state',
        sessionId: 's1',
        totalCostUSD: 0.01,
        modelUsage: {
            'claude-haiku-5-5': {inputTokens: 24, outputTokens: 884, thinkingTokens: 460, cacheReadInputTokens: 527082, cacheCreationInputTokens: 31785, costUSD: 0.01},
        },
    });

    it('reads Claude Code\'s totals per model', () => {
        expect(parseCostStateLine(line)).toEqual({
            sessionId: 's1',
            models: new Map([['claude-haiku-5-5', {input: 24, cacheWrite: 31785, cacheRead: 527082, output: 884}]]),
        });
    });

    it('reads an empty modelUsage', () => {
        expect(parseCostStateLine(JSON.stringify({type: 'cost-state', sessionId: 's', modelUsage: {}}))?.models.size).toBe(0);
    });

    it.each([
        ['an assistant line', assistantLine()],
        ['a negative count', line.replace('"inputTokens":24', '"inputTokens":-1')],
        ['no session', JSON.stringify({type: 'cost-state', modelUsage: {}})],
        ['truncated JSON', line.slice(0, 40)],
    ])('ignores %s', (_name, text) => {
        expect(parseCostStateLine(text)).toBeNull();
    });
});

describe('mayHoldUsage', () => {
    it('lets usage and cost-state lines through', () => {
        expect(mayHoldUsage(assistantLine())).toBe(true);
        expect(mayHoldUsage('{"type":"cost-state"}')).toBe(true);
    });

    it('skips other lines', () => {
        expect(mayHoldUsage(JSON.stringify({type: 'user', message: {content: 'assistant'}}))).toBe(false);
    });
});

describe('freshTokens and processedTokens', () => {
    const tokens = {input: 24, cacheWrite: 31785, cacheRead: 527082, output: 884};

    it('fresh is input + cache write + output', () => {
        expect(freshTokens(tokens)).toBe(24 + 31785 + 884);
    });

    it('processed adds cache reads', () => {
        expect(processedTokens(tokens)).toBe(24 + 31785 + 884 + 527082);
    });
});
