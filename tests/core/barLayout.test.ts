// SPDX-License-Identifier: GPL-2.0-or-later
import {describe, expect, it} from 'vitest';
import {barLayout} from '../../src/core/barLayout.js';

describe('barLayout', () => {
    it('gives the measured share of the width it was given', () => {
        expect(barLayout(340, 27, null)).toEqual({measured: 92, estimated: 0});
        expect(barLayout(340, 100, null)).toEqual({measured: 340, estimated: 0});
        expect(barLayout(340, 0, null)).toEqual({measured: 0, estimated: 0});
    });

    it('follows the width: the same percentage on another width', () => {
        expect(barLayout(200, 50, null).measured).toBe(100);
        expect(barLayout(7, 50, null).measured).toBe(4);
    });

    it('puts the estimated part right after the measured one', () => {
        expect(barLayout(340, 27, 40)).toEqual({measured: 92, estimated: 44});
        expect(barLayout(100, 61, 68)).toEqual({measured: 61, estimated: 7});
    });

    it('has no estimated part when the estimate is not above the measurement', () => {
        expect(barLayout(100, 61, 61).estimated).toBe(0);
        expect(barLayout(100, 61, 50).estimated).toBe(0);
    });

    it('never exceeds the bar', () => {
        const layout = barLayout(100, 90, 250);
        expect(layout.measured + layout.estimated).toBe(100);
        expect(barLayout(100, 400, null).measured).toBe(100);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, -5])('treats %s as empty', value => {
        expect(barLayout(100, value, null)).toEqual({measured: 0, estimated: 0});
    });

    it.each([0, -10, Number.NaN])('has nothing to draw on a width of %s', width => {
        expect(barLayout(width, 50, 60)).toEqual({measured: 0, estimated: 0});
    });
});
