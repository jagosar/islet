import {describe, expect, it} from 'vitest';
import {freshTokens, parseUsageLine, processedTokens} from '../../../src/core/usage/claudeTranscript.js';

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

describe('freshTokens and processedTokens', () => {
    const tokens = {input: 24, cacheWrite: 31785, cacheRead: 527082, output: 884};

    it('fresh is input + cache write + output', () => {
        expect(freshTokens(tokens)).toBe(24 + 31785 + 884);
    });

    it('processed adds cache reads', () => {
        expect(processedTokens(tokens)).toBe(24 + 31785 + 884 + 527082);
    });
});
