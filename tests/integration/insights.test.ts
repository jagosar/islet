// SPDX-License-Identifier: GPL-2.0-or-later
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Sandbox, line, waitFor} from './harness.js';

interface Plan {
    measuredAt: number;
    source?: string;
    fiveHour?: {usedPercentage: number; resetsAt?: number};
    sevenDay?: {usedPercentage: number; resetsAt?: number};
}

/** "resets 4:20pm (UTC)" for a moment `minutes` from now, rounded down to the minute. */
function resetText(minutes: number): {text: string; at: number} {
    const date = new Date(Date.now() + minutes * 60_000);
    date.setUTCSeconds(0, 0);
    const hour = date.getUTCHours();
    const clock = `${hour % 12 || 12}:${String(date.getUTCMinutes()).padStart(2, '0')}${hour < 12 ? 'am' : 'pm'}`;
    return {text: `You've hit your session limit · resets ${clock} (UTC)`, at: date.getTime() / 1000};
}

describe('usage insights and plan sources', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
        sandbox = await Sandbox.create();
        // Claude Code and the desktop app are installed: their folders exist, the files do not yet.
        mkdirSync(join(sandbox.claude, 'projects'), {recursive: true});
        mkdirSync(join(sandbox.config, 'Claude'), {recursive: true});
        await sandbox.startDaemon();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    const plan = () => (sandbox.property('PlanUsage').plan ?? null) as Plan | null;
    const insights = () => sandbox.property('Insights').insights as {
        day: {requests: number; attribution: {kind: string; name: string; share: number}[]};
        session: {sessionId: string; project: string; exact: boolean} | null;
    } | null;

    it("publishes what is using the limits, from Claude Code's own attribution", async () => {
        const big = {input: 0, cacheWrite: 0, cacheRead: 0, output: 100_000};
        sandbox.writeTranscript('-work', 'w1', [
            line.assistant('w1', 'i1', 'claude-sonnet-5-5', big, undefined, {attributionMcpServer: 'ccd_turn', cwd: '/home/me/code/islet'}),
            line.assistant('w1', 'i2', 'claude-sonnet-5-5', big, undefined, {attributionSkill: 'architect', cwd: '/home/me/code/islet'}),
        ]);
        const day = await waitFor('the insights', () => insights()?.day.requests === 2 && insights()!.day);
        // Equal shares are listed by name.
        expect(day.attribution.map(row => [row.kind, row.name, Math.round(row.share * 100)])).toEqual([
            ['skill', 'architect', 50], ['mcp', 'ccd_turn', 50],
        ]);
        expect(insights()?.session).toMatchObject({sessionId: 'w1', project: 'islet', exact: false});
    });

    it('reads plan usage from the Claude desktop app history, also when the file appears later', async () => {
        const now = Date.now();
        sandbox.writeDesktopHistory([{t: now - 60_000, fh: 45, sd: 20}]);
        const reading = await waitFor('the desktop reading', () => plan()?.source === 'desktop' && plan());
        expect(reading).toEqual({measuredAt: Math.floor((now - 60_000) / 1000), source: 'desktop', fiveHour: {usedPercentage: 45}, sevenDay: {usedPercentage: 20}});

        sandbox.writeDesktopHistory([{t: now - 60_000, fh: 45, sd: 20}, {t: now - 30_000, fh: 52, sd: 21}]);
        await waitFor('the newer sample', () => plan()?.fiveHour?.usedPercentage === 52);
    });

    it('takes a limit message: 100% until the reset time it names', async () => {
        const {text, at} = resetText(90);
        sandbox.writeTranscript('-work', 'w2', [line.limit('w2', text)]);
        const reading = await waitFor('the limit reading', () => plan()?.source === 'limit' && plan());
        expect(reading.fiveHour).toEqual({usedPercentage: 100, resetsAt: at});
        // The desktop's weekly figure is kept: the message is about the session window only.
        expect(reading.sevenDay).toEqual({usedPercentage: 21});
    });

    it('then keeps that reset time for a newer desktop reading of the same window', async () => {
        const before = plan()!;
        sandbox.writeDesktopHistory([{t: Date.now(), fh: 100, sd: 22}]);
        const reading = await waitFor('the newer desktop reading', () => plan()?.source === 'desktop' && plan());
        expect(reading.fiveHour).toEqual({usedPercentage: 100, resetsAt: before.fiveHour?.resetsAt});
    });

    it('ignores a limit whose reset has passed, from an old transcript', async () => {
        const before = plan()!;
        sandbox.writeTranscript('-old', 'w3', [line.limit('w3', "You've hit your session limit · resets 1:00am (UTC)", '2026-01-01T00:30:00.000Z')]);
        await new Promise(done => setTimeout(done, 1500));
        expect(plan()).toEqual(before);
    });
});
