// SPDX-License-Identifier: GPL-2.0-or-later
import {readFileSync} from 'node:fs';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Sandbox, line, todayModels, waitFor} from './harness.js';

/**
 * Budgets from issue #16: the daemon stays small on a heavy history. Decoding transcripts in
 * large chunks, or reading raw bytes per line, kept 150 to 230 MB resident on this data;
 * reading lines with read_line_utf8 stays near 45 MB. A generous bound keeps the test stable.
 */
describe('daemon on a heavy transcript history', () => {
    let sandbox: Sandbox;
    const FILES = 150;
    const LINES_PER_FILE = 300;

    beforeAll(async () => {
        sandbox = await Sandbox.create();
        // ~120 MB: per file, 150 user lines of ~2.7 KB of text and 150 responses, each repeated once.
        const filler = 'lorem ipsum dolor sit amet '.repeat(100);
        for (let file = 0; file < FILES; file++) {
            const session = `perf-${file}`;
            const lines: string[] = [];
            for (let i = 0; i < LINES_PER_FILE / 2; i++) {
                lines.push(line.user(session, filler));
                const response = line.assistant(session, `msg-${file}-${i}`, 'perf-model', {input: 3, cacheWrite: 2000, cacheRead: 40_000, output: 400});
                lines.push(response, response);
            }
            sandbox.writeTranscript(`-project${file % 20}`, session, lines);
        }
        await sandbox.startDaemon();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    const rssMb = () => {
        const status = readFileSync(`/proc/${sandbox.daemonProcess!.pid}/status`, 'utf8');
        return Number(/VmRSS:\s+(\d+)/.exec(status)![1]) / 1024;
    };

    it('counts every response once and stays under its memory budget', async () => {
        const totals = await waitFor('the whole history', () => {
            const model = todayModels(sandbox.property('Usage'))['perf-model'] as {output: number} | undefined;
            // The synthetic timestamps are "now", so all of it is today's.
            return model?.output === FILES * (LINES_PER_FILE / 2) * 400 ? model : null;
        }, 60_000);
        expect(totals.output).toBe(FILES * 150 * 400);
        expect(rssMb()).toBeLessThan(90);
    });

    it('is idle when nothing changes', async () => {
        const cpu = () => {
            const fields = readFileSync(`/proc/${sandbox.daemonProcess!.pid}/stat`, 'utf8').split(' ');
            return Number(fields[13]) + Number(fields[14]);
        };
        await new Promise(done => setTimeout(done, 1000)); // Let the scan settle.
        const before = cpu();
        await new Promise(done => setTimeout(done, 5000));
        const ticks = cpu() - before;
        expect(ticks).toBeLessThanOrEqual(5); // Clock ticks of 10 ms: at most 50 ms of CPU in 5 s.
    });
});

/**
 * A transcript line can be huge (an image as base64 in a tool result). The whole line is read at
 * once, so memory peaks at a few times its size, then comes back: measured 151 MB at peak for a
 * 40 MB line, 36 MB afterwards. The line is accepted (its response is still counted), not skipped.
 */
describe('a very large transcript line', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
        sandbox = await Sandbox.create();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('is read without losing what surrounds it, and memory comes back down', async () => {
        const huge = JSON.stringify({type: 'user', sessionId: 'big', timestamp: new Date().toISOString(), message: {content: 'A'.repeat(30_000_000)}});
        sandbox.writeTranscript('-big', 'big', [line.assistant('big', 'b1', 'big-model'), huge, line.assistant('big', 'b2', 'big-model')]);
        await sandbox.startDaemon();
        await waitFor('both responses', () => (todayModels(sandbox.property('Usage'))['big-model'] as {output: number} | undefined)?.output === 80, 30_000);

        const status = readFileSync(`/proc/${sandbox.daemonProcess!.pid}/status`, 'utf8');
        const kb = (field: string) => Number(new RegExp(`${field}:\\s+(\\d+)`).exec(status)![1]);
        expect(kb('VmHWM') / 1024).toBeLessThan(250); // Peak.
        await waitFor('memory to come back', () => {
            const now = readFileSync(`/proc/${sandbox.daemonProcess!.pid}/status`, 'utf8');
            return Number(/VmRSS:\s+(\d+)/.exec(now)![1]) / 1024 < 90;
        }, 15_000);
    });
});
