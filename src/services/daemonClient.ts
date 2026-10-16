// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, INTERFACE_NAME, INTERFACE_XML, OBJECT_PATH} from '../core/dbus.js';
import {
    decodePlanUsage, decodeSessions, decodeUsage,
    type AgentSession, type PlanUsage, type UsageSnapshot,
} from '../core/protocol.js';

const SIGTERM = 15;
const CALL_TIMEOUT_MS = 1000;
const FIRST_RESTART_DELAY_S = 1;
const MAX_RESTART_DELAY_S = 60;
/** A daemon that ran this long before exiting resets the restart backoff. */
const STABLE_RUN_S = 60;

export interface DaemonState {
    available: boolean;
    usage: UsageSnapshot | null;
    plan: PlanUsage | null;
    sessions: AgentSession[];
}

export interface DaemonClientCallbacks {
    onState(state: DaemonState): void;
    onAgentEvent(fields: Record<string, string>): void;
}

/**
 * Runs the daemon as a child process and mirrors its D-Bus properties. One instance per
 * enable(); stop() cancels everything it started.
 *
 * If the daemon exits while no other daemon owns the bus name, it is restarted with a growing
 * delay (1 s up to 60 s). If another daemon owns the name (a newer one replaced it), nothing is
 * restarted: the proxy simply follows the new owner.
 */
export class DaemonClient {
    private readonly cancellable = new Gio.Cancellable();
    private proxy: Gio.DBusProxy | null = null;
    private process: Gio.Subprocess | null = null;
    private startedAt = 0;
    private restartDelay = FIRST_RESTART_DELAY_S;
    private restartId = 0;
    private stopped = false;

    constructor(
        private readonly daemonPath: string,
        private readonly callbacks: DaemonClientCallbacks,
    ) {}

    start(): void {
        const info = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML).lookup_interface(INTERFACE_NAME);
        Gio.DBusProxy.new_for_bus(
            Gio.BusType.SESSION, Gio.DBusProxyFlags.DO_NOT_AUTO_START, info,
            BUS_NAME, OBJECT_PATH, INTERFACE_NAME, this.cancellable,
            (_source, result) => {
                try {
                    this.proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (error) {
                    if (!this.cancellable.is_cancelled())
                        console.error(`Islet: could not create the D-Bus proxy: ${String(error)}`);
                    return;
                }
                this.proxy.connectObject(
                    'g-properties-changed', () => this.emitState(),
                    'notify::g-name-owner', () => this.emitState(),
                    'g-signal', (_proxy: Gio.DBusProxy, _sender: string, name: string, parameters: GLib.Variant) => {
                        if (name === 'AgentEvent') {
                            const [fields] = parameters.deepUnpack() as [Record<string, string>];
                            this.callbacks.onAgentEvent(fields);
                        }
                    },
                    this);
                this.emitState();
            });

        this.spawn();
    }

    reportAgentEvent(fields: Record<string, string>): void {
        this.proxy?.call(
            'ReportAgentEvent', new GLib.Variant('(a{ss})', [fields]),
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, this.cancellable,
            (proxy, result) => {
                try {
                    proxy?.call_finish(result);
                } catch (error) {
                    if (!this.cancellable.is_cancelled())
                        console.warn(`Islet: could not reach the daemon: ${String(error)}`);
                }
            });
    }

    stop(): void {
        this.stopped = true;
        this.cancellable.cancel();
        if (this.restartId) {
            GLib.source_remove(this.restartId);
            this.restartId = 0;
        }
        this.proxy?.disconnectObject(this);
        this.proxy = null;
        this.process?.send_signal(SIGTERM);
        this.process = null;
    }

    private spawn(): void {
        const gjs = GLib.find_program_in_path('gjs');
        if (!gjs) {
            console.error('Islet: gjs was not found in PATH, so the daemon cannot start');
            return;
        }

        let process: Gio.Subprocess;
        try {
            process = Gio.Subprocess.new([gjs, '-m', this.daemonPath], Gio.SubprocessFlags.NONE);
        } catch (error) {
            // A failure to start the daemon must not take the extension down with it: the capsule
            // shows "unavailable", and starting is retried with the same backoff as a crash.
            console.error(`Islet: could not start the daemon: ${String(error)}`);
            this.scheduleRestart('could not start');
            return;
        }
        this.process = process;
        this.startedAt = GLib.get_monotonic_time();
        process.wait_async(this.cancellable, (_source, result) => {
            try {
                process.wait_finish(result);
            } catch {
                return; // Cancelled by stop().
            }
            if (this.process === process)
                this.onExit(process);
        });
    }

    private onExit(process: Gio.Subprocess): void {
        this.process = null;
        const how = process.get_if_exited() ? `status ${process.get_exit_status()}` : 'a signal';

        const ranFor = (GLib.get_monotonic_time() - this.startedAt) / 1_000_000;
        if (ranFor >= STABLE_RUN_S)
            this.restartDelay = FIRST_RESTART_DELAY_S;
        this.scheduleRestart(`exited with ${how}`);
    }

    /**
     * Starts the daemon again after the backoff delay, unless another daemon owns the bus name by
     * then. The decision is made when the delay is over, not now: at exit time the proxy may not
     * have seen the name released yet, and a daemon that replaced this one would still own it.
     */
    private scheduleRestart(reason: string): void {
        this.restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, this.restartDelay, () => {
            this.restartId = 0;
            if (this.stopped)
                return GLib.SOURCE_REMOVE;
            // If another daemon owns the name, it serves Islet: nothing to start, nothing to log.
            if (!this.proxy?.g_name_owner) {
                console.warn(`Islet: the daemon ${reason}; starting it`);
                this.spawn();
            }
            return GLib.SOURCE_REMOVE;
        });
        this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_DELAY_S);
    }

    private emitState(): void {
        const read = (name: string): string => (this.proxy?.get_cached_property(name)?.unpack() as string | undefined) ?? '';
        const available = Boolean(this.proxy?.g_name_owner);
        this.callbacks.onState({
            available,
            usage: available ? decodeUsage(read('Usage')) : null,
            plan: available ? decodePlanUsage(read('PlanUsage')) : null,
            sessions: available ? decodeSessions(read('Sessions')) ?? [] : [],
        });
    }
}
