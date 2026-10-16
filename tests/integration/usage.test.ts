// SPDX-License-Identifier: GPL-2.0-or-later
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {Sandbox, line, todayModels, waitFor} from './harness.js';

const fresh = (m: {input: number; cacheWrite: number; output: number}) => m.input + m.cacheWrite + m.output;

describe('usage from transcripts', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
        sandbox = await Sandbox.create();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    const usageOf = (model: string) => todayModels(sandbox.property('Usage'))[model];

    it('scans existing transcripts at start and counts each response once', async () => {
        const model = 'scan-model';
        sandbox.writeTranscript('-p1', 's1', [
            line.user('s1'),
            line.assistant('s1', 'a', model), line.assistant('s1', 'a', model), // One response, repeated per content block.
            line.assistant('s1', 'b', model),
        ]);
        await sandbox.startDaemon();
        const totals = await waitFor('the initial scan', () => usageOf(model));
        expect(totals).toEqual({input: 20, cacheWrite: 400, cacheRead: 6000, output: 80});
    });

    it('counts appended responses, and waits for the end of a partial line', async () => {
        const model = 'append-model';
        const path = sandbox.writeTranscript('-p2', 's2', [line.assistant('s2', 'x', model)]);
        await waitFor('the first response', () => usageOf(model));

        const next = line.assistant('s2', 'y', model);
        sandbox.append(path, next.slice(0, 50)); // The writer has not finished the line.
        await new Promise(done => setTimeout(done, 1200));
        expect(fresh(usageOf(model)!)).toBe(250);

        sandbox.append(path, `${next.slice(50)}\n`);
        await waitFor('the completed line', () => fresh(usageOf(model)!) === 500);
    });

    it('picks up transcripts in a folder created after start', async () => {
        const model = 'new-folder-model';
        sandbox.writeTranscript('-brand-new-project', 's3', [line.assistant('s3', 'n1', model)]);
        expect(await waitFor('the new folder', () => usageOf(model))).toMatchObject({output: 40});
    });

    it('does not count a rewritten file twice', async () => {
        const model = 'rewrite-model';
        const path = sandbox.writeTranscript('-p4', 's4', [line.assistant('s4', 'r1', model)]);
        await waitFor('the response', () => usageOf(model));
        sandbox.writeTranscript('-p4', 's4', [line.assistant('s4', 'r1', model), line.assistant('s4', 'r2', model)]);
        await waitFor('the second response', () => fresh(usageOf(model)!) === 500);
        await new Promise(done => setTimeout(done, 800));
        expect(fresh(usageOf(model)!)).toBe(500);
        expect(sandbox.exists(path)).toBe(true);
    });

    it('counts a response copied into a resumed session once', async () => {
        const model = 'resume-model';
        sandbox.writeTranscript('-p5', 'original', [line.assistant('original', 'shared', model)]);
        await waitFor('the original', () => usageOf(model));
        sandbox.writeTranscript('-p5', 'resumed', [line.assistant('resumed', 'shared', model), line.assistant('resumed', 'own', model)]);
        await waitFor('the resumed session', () => fresh(usageOf(model)!) === 500);
        await new Promise(done => setTimeout(done, 800));
        expect(fresh(usageOf(model)!)).toBe(500);
    });

    it('reconciles an ended session with Claude Code\'s own totals (cost-state)', async () => {
        const model = 'cost-model';
        sandbox.writeTranscript('-p6', 's6', [
            line.assistant('s6', 'c1', model),
            line.costState('s6', model, {input: 100, cacheWrite: 1000, cacheRead: 9000, output: 400}),
        ]);
        expect(await waitFor('the reconciled totals', () => usageOf(model))).toEqual({input: 100, cacheWrite: 1000, cacheRead: 9000, output: 400});
    });

    it('ignores lines that are not usage, and malformed JSON', async () => {
        const model = 'noise-model';
        sandbox.writeTranscript('-p7', 's7', ['{"type":"system","subtype":"x"}', '{not json', line.assistant('s7', 'z', model), '']);
        expect(await waitFor('the valid response', () => usageOf(model))).toMatchObject({output: 40});
        expect(sandbox.daemonLog).not.toMatch(/JS ERROR|cannot read/);
    });

    it('keeps its totals across a daemon restart without double counting', async () => {
        const model = 'restart-model';
        sandbox.writeTranscript('-p8', 's8', [line.assistant('s8', 'q1', model)]);
        await waitFor('the response', () => usageOf(model));
        await sandbox.stopDaemon();
        await sandbox.startDaemon();
        expect(await waitFor('the rescan', () => usageOf(model))).toEqual({input: 10, cacheWrite: 200, cacheRead: 3000, output: 40});
    });
});
