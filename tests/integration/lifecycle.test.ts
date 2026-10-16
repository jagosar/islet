// SPDX-License-Identifier: GPL-2.0-or-later
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {DIST, Sandbox, isRunning, waitFor} from './harness.js';

describe('daemon lifecycle', () => {
    let sandbox: Sandbox;
    beforeAll(async () => {
        sandbox = await Sandbox.create();
    });
    afterAll(async () => {
        await sandbox.destroy();
    });

    it('is replaced by a newer daemon, which then owns the name', async () => {
        await sandbox.startDaemon();
        const first = sandbox.daemonProcess!;
        const second = spawn('gjs', ['-m', join(DIST, 'daemon/main.js')], {env: sandbox.env(), stdio: 'ignore'});
        try {
            await waitFor('the first daemon to exit', () => !isRunning(first), 10_000);
            expect(first.exitCode).toBe(0);
            expect(sandbox.run('ping').status).toBe(0);
        } finally {
            second.kill('SIGTERM');
            await new Promise(done => second.once('exit', done));
        }
    });

    it('stops on SIGTERM and leaves nothing running', async () => {
        await waitFor('the name to be free', () => sandbox.run('ping').status !== 0, 10_000);
        await sandbox.startDaemon();
        const daemon = sandbox.daemonProcess!;
        await sandbox.stopDaemon();
        expect(isRunning(daemon)).toBe(false);
    });

    it('exits when GNOME Shell leaves the bus (outside standalone mode)', async () => {
        const daemon = spawn('gjs', ['-m', join(DIST, 'daemon/main.js')], {env: {...sandbox.env(), ISLET_STANDALONE: ''}, stdio: 'ignore'});
        // Without org.gnome.Shell on the bus the watcher reports it missing straight away.
        await waitFor('the daemon to exit', () => !isRunning(daemon), 10_000);
        expect(daemon.exitCode).toBe(0);
    });
});
