import {describe, expect, it} from 'vitest';
import {formatPlanStatusLine, planReportFromStatusLine} from '../../src/core/statusLine.js';

const input = {
    session_id: 's',
    model: {id: 'claude-opus-5-5', display_name: 'Opus'},
    cost: {total_cost_usd: 1.23},
    rate_limits: {
        five_hour: {used_percentage: 23.5, resets_at: 1738425600},
        seven_day: {used_percentage: 41.2, resets_at: 1738857600},
        spend_limit: {used_percentage: 62.8, resets_at: 1740787200},
    },
};

describe('planReportFromStatusLine', () => {
    it('keeps only the 5-hour and 7-day figures', () => {
        expect(planReportFromStatusLine(JSON.stringify(input))).toEqual({
            five_hour_used_percentage: 23.5, five_hour_resets_at: 1738425600,
            seven_day_used_percentage: 41.2, seven_day_resets_at: 1738857600,
        });
    });

    it('accepts a single window', () => {
        expect(planReportFromStatusLine(JSON.stringify({rate_limits: {seven_day: {used_percentage: 4, resets_at: 9}}})))
            .toEqual({seven_day_used_percentage: 4, seven_day_resets_at: 9});
    });

    it.each([
        ['no rate_limits (API user, or before the first reply)', {session_id: 's'}],
        ['empty rate_limits', {rate_limits: {}}],
        ['a window missing its reset time', {rate_limits: {five_hour: {used_percentage: 10}}}],
        ['non-numeric figures', {rate_limits: {five_hour: {used_percentage: '10', resets_at: 9}}}],
    ])('returns null for %s', (_name, value) => {
        expect(planReportFromStatusLine(JSON.stringify(value))).toBeNull();
    });

    it('returns null for invalid JSON', () => {
        expect(planReportFromStatusLine('{')).toBeNull();
    });
});

describe('formatPlanStatusLine', () => {
    it.each([
        [{five_hour_used_percentage: 23.5, five_hour_resets_at: 1, seven_day_used_percentage: 41.2, seven_day_resets_at: 2}, '5h 24% · 7d 41%'],
        [{seven_day_used_percentage: 4, seven_day_resets_at: 2}, '7d 4%'],
        [null, ''],
    ])('%o -> %j', (report, expected) => {
        expect(formatPlanStatusLine(report)).toBe(expected);
    });
});
