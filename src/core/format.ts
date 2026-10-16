// SPDX-License-Identifier: GPL-2.0-or-later

const UNITS = ['K', 'M', 'B'] as const;

/**
 * Formats a token count with three significant digits ("987", "1.23K", "1.12M"), so values of
 * the same magnitude keep the same width in the capsule.
 */
export function formatTokens(count: number): string {
    if (!Number.isFinite(count) || count < 0)
        throw new RangeError(`Token count must be a finite, non-negative number, got ${count}`);

    if (count < 1000)
        return String(Math.round(count));

    let value = count;
    for (const [i, unit] of UNITS.entries()) {
        value /= 1000;
        // 999_950 would round to "1000K": carry over to the next unit instead.
        if (Number(value.toPrecision(3)) < 1000)
            return `${value.toPrecision(3)}${unit}`;
        if (i === UNITS.length - 1)
            return `${Math.round(value)}${unit}`;
    }

    throw new Error('unreachable');
}
