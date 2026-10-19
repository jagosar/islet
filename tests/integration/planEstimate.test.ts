// SPDX-License-Identifier: GPL-2.0-or-later
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Sandbox, line, waitFor} from './harness.js';

interface Estimate {
    fiveHour: number;
    basedOn: number;
    at: number;
}

const MIN = 60_000;
/** Output tokens worth $1.00 at Sonnet prices ($3 per million input tokens, output costs 5x). */
const ONE_DOLLAR = {input: 0, cacheWrite: 0, cacheRead: 0, output: 66_667};

describe('the 5-hour estimate between two measurements', () => {
    let sandbox: Sandbox;
    const now = Date.now();
    const at = (minutesAgo: number) => now - minutesAgo * MIN;

    /** Requests of $1 each, `minutesAgo` minutes ago. */
    const requests = (session: string, prefix: string, minutesAgo: number[]) =>
        minutesAgo.map((m, i) => line.assistant(session, `${prefix}${i}`, 'claude-sonnet-5-5', ONE_DOLLAR, new Date(at(m)).toISOString()));

    const estimate = () => (sandbox.property('PlanEstimate').estimate ?? null) as Estimate | null;
    const plan = () => sandbox.property('PlanUsage').plan as {measuredAt: number; fiveHour: {usedPercentage: number}} | null;

    beforeAll(async () => {
        sandbox = await Sandbox.create();
        mkdirSync(join(sandbox.claude, 'projects'), {recursive: true});
        // Five 15-minute intervals, $3 each, and the window rises 6 points in each: 2 points per dollar.
        // Then $2 more in the last 4 minutes, after the last measurement.
        const intervals = [80, 65, 50, 35, 20].flatMap(start => [start - 3, start - 8, start - 13]);
        sandbox.writeTranscript('-work', 'est', [...requests('est', 'a', intervals), ...requests('est', 'b', [3, 2])]);
        sandbox.writeDesktopHistory([0, 6, 12, 18, 24, 30].map((fh, i) => ({t: at(79 - i * 15), fh, sd: 5})));
        await sandbox.startDaemon();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('extends the latest measurement with what was used since, at the pace learned from the history', async () => {
        const result = await waitFor('the estimate', estimate);
        expect(result.fiveHour).toBeGreaterThan(33.5);        // 30 measured + 2 dollars at 2 points per dollar
        expect(result.fiveHour).toBeLessThan(34.5);
        expect(result.basedOn).toBe(plan()!.measuredAt);
        expect(plan()!.fiveHour.usedPercentage).toBe(30);      // the measurement itself is never changed
    });

    it('goes away when a newer measurement arrives, which wins', async () => {
        sandbox.writeDesktopHistory([0, 6, 12, 18, 24, 30].map((fh, i) => ({t: at(79 - i * 15), fh, sd: 5})).concat([{t: at(1), fh: 36, sd: 5}]));
        await waitFor('the newer measurement', () => plan()?.fiveHour.usedPercentage === 36);
        // Nothing was used since that measurement, a minute ago.
        await waitFor('no estimate for it', () => estimate() === null);
    });

    it('follows new usage: another two dollars, and the estimate is back', async () => {
        const path = sandbox.transcriptPath('-work', 'est');
        sandbox.append(path, requests('est', 'c', [0]).concat(requests('est', 'd', [0])).map(l => `${l}\n`).join(''));
        const result = await waitFor('the new estimate', () => {
            const e = estimate();
            return e && e.fiveHour > 39.5 ? e : null;           // 36 measured + 2 dollars at 2 points per dollar
        });
        expect(result.fiveHour).toBeLessThan(40.5);
    });
});

describe('without a pace to learn from', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
        sandbox = await Sandbox.create();
        mkdirSync(join(sandbox.claude, 'projects'), {recursive: true});
        sandbox.writeTranscript('-work', 'few', [line.assistant('few', 'x', 'claude-sonnet-5-5', ONE_DOLLAR, new Date(Date.now() - 2 * MIN).toISOString())]);
        sandbox.writeDesktopHistory([{t: Date.now() - 10 * MIN, fh: 10, sd: 2}, {t: Date.now() - 5 * MIN, fh: 12, sd: 2}]);
        await sandbox.startDaemon();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('shows the measurement and no estimate', async () => {
        await waitFor('the measurement', () => sandbox.property('PlanUsage').plan);
        await new Promise(done => setTimeout(done, 2000));
        expect(sandbox.property('PlanEstimate').estimate).toBeNull();
    });
});

describe('a measurement that is too old', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
        sandbox = await Sandbox.create();
        mkdirSync(join(sandbox.claude, 'projects'), {recursive: true});
        const now = Date.now();
        // A clear pace, but the last measurement is 50 minutes old (the app is probably not running).
        // The last three happened after the last measurement: without the age limit they would extend it.
        const times = [135, 130, 125, 120, 115, 110, 105, 100, 95, 90, 85, 80, 75, 70, 65, 60, 55, 55, 52, 51, 45, 30, 10];
        sandbox.writeTranscript('-work', 'old', times.map((m, i) =>
            line.assistant('old', `o${i}`, 'claude-sonnet-5-5', ONE_DOLLAR, new Date(now - m * MIN).toISOString())));
        sandbox.writeDesktopHistory([0, 6, 12, 18, 24, 30, 36].map((fh, i) => ({t: now - (140 - i * 15) * MIN, fh, sd: 5})));
        await sandbox.startDaemon();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('is shown as measured, with no estimate', async () => {
        const plan = await waitFor('the measurement', () => sandbox.property('PlanUsage').plan as {fiveHour: {usedPercentage: number}} | null);
        expect(plan.fiveHour.usedPercentage).toBe(36);
        await new Promise(done => setTimeout(done, 2000));
        expect(sandbox.property('PlanEstimate').estimate).toBeNull();
    });
});
