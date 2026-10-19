import {describe, expect, it} from 'vitest';
import {
    freshTokens, mayHoldUsage, parseCostStateLine, parseLimitLine, parseResetTime, parseUsageLine, processedTokens,
} from '../../../src/core/usage/claudeTranscript.js';

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
            sidechain: false,
            attribution: {},
        });
    });

    it('reads the attribution, the subagent flag and the project, never the content', () => {
        const record = parseUsageLine(assistantLine({
            isSidechain: true, cwd: '/home/me/code/islet/',
            attributionMcpServer: 'ccd_turn', attributionMcpTool: 'wrap_up', attributionSkill: 'architect',
            attributionAgent: 'implementer', attributionPlugin: 'agentic-flow',
        }));
        expect(record).toMatchObject({
            sidechain: true, project: 'islet',
            attribution: {mcpServer: 'ccd_turn', skill: 'architect', agent: 'implementer', plugin: 'agentic-flow'},
        });
        expect(JSON.stringify(record)).not.toContain('never read');
    });

    it('ignores empty or non-text attribution and cuts long names', () => {
        const record = parseUsageLine(assistantLine({attributionSkill: '  ', attributionAgent: 7, attributionMcpServer: 'x'.repeat(200)}));
        expect(record?.attribution).toEqual({mcpServer: 'x'.repeat(80)});
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
            modelCostUsd: new Map([['claude-haiku-5-5', 0.01]]),
            totalCostUsd: 0.01,
        });
    });

    it('reads the session totals Claude Code shows in /usage', () => {
        const state = parseCostStateLine(JSON.stringify({
            type: 'cost-state', sessionId: 's', modelUsage: {}, totalCostUSD: 86.5,
            totalAPIDuration: 8_280_000, totalLinesAdded: 9226, totalLinesRemoved: 98,
        }));
        expect(state).toMatchObject({totalCostUsd: 86.5, apiDurationMs: 8_280_000, linesAdded: 9226, linesRemoved: 98});
    });

    it('leaves out totals that are not counts', () => {
        const state = parseCostStateLine(JSON.stringify({type: 'cost-state', sessionId: 's', modelUsage: {}, totalCostUSD: -1, totalLinesAdded: 'many'}));
        expect(state).toEqual({sessionId: 's', models: new Map(), modelCostUsd: new Map()});
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

function limitLine(text: string, timestamp = '2026-10-18T12:35:21.777Z', overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        type: 'assistant', sessionId: 's1', timestamp, isApiErrorMessage: true, error: 'rate_limit', apiError: 'usage_limit_reached',
        message: {id: 'x', model: '<synthetic>', content: [{type: 'text', text}]},
        ...overrides,
    });
}

const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('parseResetTime', () => {
    it('reads a time later the same day, in the named zone (CEST is UTC+2)', () => {
        expect(parseResetTime('resets 4:20pm (Europe/Berlin)', Date.parse('2026-10-18T12:35:21Z'))).toBe(at('2026-10-18T14:20:00Z'));
    });

    it('rolls a time that has passed over to the next day', () => {
        expect(parseResetTime('resets 2:20am (Europe/Berlin)', Date.parse('2026-10-18T20:48:17Z'))).toBe(at('2026-10-19T00:20:00Z'));
    });

    it('converts a time just before the autumn DST change with the offset in force then (CEST)', () => {
        // 01:30 on 25 October is still summer time in Berlin (UTC+2); clocks go back at 03:00.
        expect(parseResetTime('resets 1:30am (Europe/Berlin)', Date.parse('2026-10-24T20:00:00Z'))).toBe(at('2026-10-24T23:30:00Z'));
    });

    it('reads 12am and 12pm', () => {
        expect(parseResetTime('resets 12am (UTC)', Date.parse('2026-10-18T10:00:00Z'))).toBe(at('2026-10-19T00:00:00Z'));
        expect(parseResetTime('resets 12pm (UTC)', Date.parse('2026-10-18T10:00:00Z'))).toBe(at('2026-10-18T12:00:00Z'));
    });

    it('reads a date for the weekly limit, across a DST change (CET after 25 October)', () => {
        expect(parseResetTime('resets Oct 27, 10am (Europe/Berlin)', Date.parse('2026-10-19T08:00:00Z'))).toBe(at('2026-10-27T09:00:00Z'));
    });

    it('moves a date that has passed this year to the next one', () => {
        expect(parseResetTime('resets Jan 2, 9am (UTC)', Date.parse('2026-12-30T00:00:00Z'))).toBe(at('2027-01-02T09:00:00Z'));
    });

    it.each([
        ['no reset', "You've hit your session limit"],
        ['an unknown zone', 'resets 4pm (Mars/Olympus)'],
        ['an impossible hour', 'resets 13pm (UTC)'],
        ['an unknown month', 'resets Foo 3, 4pm (UTC)'],
    ])('gives up on %s', (_name, text) => {
        expect(parseResetTime(text, Date.parse('2026-10-18T12:00:00Z'))).toBeUndefined();
    });
});

describe('parseLimitLine', () => {
    it('reads a session limit and its reset', () => {
        expect(parseLimitLine(limitLine("You've hit your session limit · resets 4:20pm (Europe/Berlin)"))).toEqual({
            window: 'session', at: at('2026-10-18T12:35:21Z'), resetsAt: at('2026-10-18T14:20:00Z'),
        });
    });

    it('reads a weekly limit', () => {
        expect(parseLimitLine(limitLine("You've hit your weekly limit · resets Oct 21, 10am (Europe/Berlin)"))?.window).toBe('weekly');
    });

    it('keeps a limit whose reset it cannot read, without a reset', () => {
        expect(parseLimitLine(limitLine("You've hit your Opus limit"))).toEqual({window: 'other', at: at('2026-10-18T12:35:21Z')});
    });

    it.each([
        ['a normal response', assistantLine()],
        ['another API error', limitLine('Overloaded', undefined, {apiError: 'overloaded_error'})],
        ['a user line quoting the text', JSON.stringify({type: 'user', apiError: 'usage_limit_reached', timestamp: '2026-10-18T12:00:00Z'})],
        ['truncated JSON', limitLine('x').slice(0, 60)],
    ])('ignores %s', (_name, text) => {
        expect(parseLimitLine(text)).toBeNull();
    });

    it('is let through the cheap pre-check', () => {
        expect(mayHoldUsage(limitLine('x'))).toBe(true);
    });
});
