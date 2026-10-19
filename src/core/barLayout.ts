// SPDX-License-Identifier: GPL-2.0-or-later

/** Pixel widths of a plan bar's two segments, from the width the bar was actually given. */
export interface BarLayout {
    /** The measured part, from the left edge. */
    measured: number;
    /** The estimated part, right after the measured one (0 when there is no estimate). */
    estimated: number;
}

function clampPercent(value: number): number {
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}

/**
 * Splits a bar of `width` pixels: `measuredPercent` of it is measured; the part up to
 * `estimatedPercent` (if higher) is estimated. Widths are whole pixels, and together never exceed
 * the bar. Computed from the allocated width at paint time, so it cannot go stale when the
 * panel is closed, reopened or resized.
 */
export function barLayout(width: number, measuredPercent: number, estimatedPercent: number | null): BarLayout {
    const total = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const measured = Math.round(total * clampPercent(measuredPercent) / 100);
    if (estimatedPercent === null)
        return {measured, estimated: 0};
    const upTo = Math.round(total * clampPercent(estimatedPercent) / 100);
    return {measured, estimated: Math.max(0, upTo - measured)};
}
