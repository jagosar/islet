// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Integration test harness: a private D-Bus session bus and, on it, the real daemon (gjs, built
 * into dist/), with temporary Claude, state and runtime directories. No GNOME Shell is needed
 * (the daemon runs with ISLET_STANDALONE=1), so these tests also run in CI.
 */
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

export const REPO = resolve(import.meta.dirname, '../..');
export const DIST = join(REPO, 'dist');
const CLIENT = join(REPO, 'tests/integration/client.js');

const BUS_CONFIG = (dir: string) => `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${dir}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>`;

export interface Result {
    status: number | null;
    stdout: string;
    stderr: string;
}

/** A child is running until it has an exit code or was ended by a signal. */
export function isRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(done => setTimeout(done, ms));
}

/** Polls `check` until it returns a truthy value; throws a descriptive error on timeout. */
export async function waitFor<T>(what: string, check: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
        try {
            const value = await check();
            if (value)
                return value;
        } catch (error) {
            last = error;
        }
        await sleep(100);
    }
    throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`);
}

export class Sandbox {
    readonly root = mkdtempSync(join(tmpdir(), 'islet-it-'));
    readonly claude = join(this.root, 'claude');
    readonly state = join(this.root, 'state');
    readonly runtime = join(this.root, 'run');
    /** dist/ as an installed extension: its folder is named by the extension's UUID, as in a real install. */
    readonly extensionDir = join(this.root, 'extensions', 'islet@jagosar.github.io');
    address = '';
    private bus: ChildProcess | null = null;
    private daemon: ChildProcess | null = null;
    daemonLog = '';

    static async create(): Promise<Sandbox> {
        const sandbox = new Sandbox();
        for (const dir of [sandbox.claude, sandbox.state, sandbox.runtime, join(sandbox.root, 'extensions')])
            mkdirSync(dir, {recursive: true, mode: 0o700});
        symlinkSync(DIST, sandbox.extensionDir);
        await sandbox.startBus();
        return sandbox;
    }

    /** The environment for processes that talk to this sandbox. */
    env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
        return {
            PATH: process.env.PATH,
            HOME: this.root,
            LANG: 'C.UTF-8',
            TZ: 'UTC',
            XDG_STATE_HOME: this.state,
            XDG_RUNTIME_DIR: this.runtime,
            XDG_CACHE_HOME: join(this.root, 'cache'),
            CLAUDE_CONFIG_DIR: this.claude,
            DBUS_SESSION_BUS_ADDRESS: this.address,
            ISLET_STANDALONE: '1',
            ...extra,
        };
    }

    private async startBus(): Promise<void> {
        const config = join(this.root, 'bus.conf');
        writeFileSync(config, BUS_CONFIG(this.root));
        const bus = spawn('dbus-daemon', ['--config-file', config, '--nofork', '--print-address=1'], {stdio: ['ignore', 'pipe', 'inherit']});
        this.bus = bus;
        this.address = await new Promise<string>((done, fail) => {
            let text = '';
            bus.stdout.on('data', (chunk: Buffer) => {
                text += chunk.toString();
                const line = text.split('\n')[0];
                if (text.includes('\n'))
                    done(line);
            });
            bus.once('error', fail);
            bus.once('exit', code => fail(new Error(`dbus-daemon exited early with ${code}`)));
        });
    }

    /** Starts the daemon and waits until it owns its bus name. */
    async startDaemon(extraEnv: Record<string, string> = {}): Promise<void> {
        if (this.daemon && isRunning(this.daemon))
            throw new Error('the daemon is already running');
        const daemon = spawn('gjs', ['-m', join(this.extensionDir, 'daemon/main.js')], {env: this.env(extraEnv), stdio: ['ignore', 'pipe', 'pipe']});
        this.daemon = daemon;
        this.daemonLog = '';
        daemon.stdout.on('data', (chunk: Buffer) => { this.daemonLog += chunk.toString(); });
        daemon.stderr.on('data', (chunk: Buffer) => { this.daemonLog += chunk.toString(); });
        await waitFor('the daemon to own its bus name', () => isRunning(daemon) && this.run('ping').status === 0, 15_000);
    }

    async stopDaemon(): Promise<void> {
        const daemon = this.daemon;
        if (!daemon || !isRunning(daemon))
            return;
        daemon.kill('SIGTERM');
        await waitFor('the daemon to exit', () => !isRunning(daemon), 5_000);
        await waitFor('the bus name to be released', () => this.run('ping').status !== 0, 5_000);
    }

    get daemonProcess(): ChildProcess | null {
        return this.daemon;
    }

    /** Runs the GJS test client. */
    run(...args: string[]): Result {
        const result = spawnSync('gjs', ['-m', CLIENT, ...args], {env: this.env(), encoding: 'utf8', timeout: 15_000});
        return {status: result.status, stdout: result.stdout, stderr: result.stderr};
    }

    /** A daemon property, parsed from its JSON document. */
    property(name: 'Usage' | 'PlanUsage' | 'Sessions'): Record<string, unknown> {
        const result = this.run('get', name);
        if (result.status !== 0)
            throw new Error(`reading ${name} failed: ${result.stderr}`);
        return JSON.parse(result.stdout) as Record<string, unknown>;
    }

    call(method: 'ReportAgentEvent' | 'ReportPlanUsage', fields: Record<string, string | number>): Result {
        return this.run('call', method, JSON.stringify(fields));
    }

    /** Runs one of the built scripts (a bridge or a tool) with gjs. */
    gjs(script: string, args: string[] = [], input?: string, extraEnv: Record<string, string> = {}): Result {
        const result = spawnSync('gjs', ['-m', join(this.extensionDir, script), ...args], {
            env: this.env(extraEnv), input, encoding: 'utf8', timeout: 30_000,
        });
        return {status: result.status, stdout: result.stdout, stderr: result.stderr};
    }

    /** Collects AgentEvent signals for `seconds` and returns them once the watcher has stopped. */
    async watchEvents(seconds: number, whileWatching: () => void | Promise<void>): Promise<Record<string, string>[]> {
        const watcher = spawn('gjs', ['-m', CLIENT, 'watch', String(seconds)], {env: this.env(), stdio: ['ignore', 'pipe', 'inherit']});
        let out = '';
        watcher.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
        await waitFor('the watcher to be ready', () => out.includes('ready'));
        await whileWatching();
        await new Promise(done => watcher.once('exit', done));
        return out.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Record<string, string>);
    }

    transcriptPath(project: string, session: string): string {
        return join(this.claude, 'projects', project, `${session}.jsonl`);
    }

    writeTranscript(project: string, session: string, lines: string[]): string {
        const path = this.transcriptPath(project, session);
        mkdirSync(join(this.claude, 'projects', project), {recursive: true});
        writeFileSync(path, lines.map(line => `${line}\n`).join(''));
        return path;
    }

    append(path: string, text: string | Buffer): void {
        appendFileSync(path, text);
    }

    read(path: string): string {
        return readFileSync(path, 'utf8');
    }

    exists(path: string): boolean {
        return existsSync(path);
    }

    async destroy(): Promise<void> {
        await this.stopDaemon().catch(() => undefined);
        this.daemon?.kill('SIGKILL');
        this.bus?.kill('SIGTERM');
        rmSync(this.root, {recursive: true, force: true});
    }
}

/** Transcript lines in the shape Claude Code writes them. */
export const line = {
    user: (session: string, text = 'hello'): string =>
        JSON.stringify({type: 'user', sessionId: session, timestamp: new Date().toISOString(), message: {role: 'user', content: text}}),

    assistant: (session: string, id: string, model = 'claude-test', tokens = {input: 10, cacheWrite: 200, cacheRead: 3000, output: 40}, timestamp = new Date().toISOString()): string =>
        JSON.stringify({
            type: 'assistant', sessionId: session, timestamp,
            message: {
                id, model, content: [{type: 'text', text: 'never read'}],
                usage: {
                    input_tokens: tokens.input, cache_creation_input_tokens: tokens.cacheWrite,
                    cache_read_input_tokens: tokens.cacheRead, output_tokens: tokens.output,
                },
            },
        }),

    costState: (session: string, model: string, tokens: {input: number; cacheWrite: number; cacheRead: number; output: number}): string =>
        JSON.stringify({
            type: 'cost-state', sessionId: session,
            modelUsage: {
                [model]: {
                    inputTokens: tokens.input, outputTokens: tokens.output, cacheReadInputTokens: tokens.cacheRead,
                    cacheCreationInputTokens: tokens.cacheWrite, costUSD: 0,
                },
            },
        }),
};

/** Today's per-model totals from a Usage document, or {} if there are none. */
export function todayModels(usage: Record<string, unknown>): Record<string, {input: number; cacheWrite: number; cacheRead: number; output: number}> {
    const today = (usage.usage as {today: {models: Record<string, never>} | null}).today;
    return today?.models ?? {};
}

export function sessionsOf(document: Record<string, unknown>): {sessionId: string; project: string; state: string}[] {
    return document.sessions as {sessionId: string; project: string; state: string}[];
}
