import {describe, expect, it} from 'vitest';
import {formatTokens} from '../../src/core/format.js';

describe('formatTokens', () => {
    it.each([
        [0, '0'],
        [999, '999'],
        [1000, '1.00K'],
        [1234, '1.23K'],
        [98_765, '98.8K'],
        [999_499, '999K'],
        [999_950, '1.00M'],
        [1_120_000, '1.12M'],
        [1_000_000_000, '1.00B'],
        [1_234_000_000_000, '1234B'],
    ])('formats %d as %s', (count, expected) => {
        expect(formatTokens(count)).toBe(expected);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %d', count => {
        expect(() => formatTokens(count)).toThrow(RangeError);
    });
});
