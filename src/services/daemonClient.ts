import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, INTERFACE_NAME, OBJECT_PATH} from '../core/dbus.js';

const SIGTERM = 15;
const CALL_TIMEOUT_MS = 1000;

/**
 * Starts the daemon as a child process and talks to it over the session bus. One instance per
 * enable(); stop() cancels everything it started, so it cannot be restarted.
 */
export class DaemonClient {
    private process: Gio.Subprocess | null = null;
    private readonly cancellable = new Gio.Cancellable();
    private signalId = 0;

    constructor(
        private readonly daemonPath: string,
        private readonly onAgentEvent: (fields: Record<string, string>) => void,
    ) {}

    start(): void {
        this.signalId = Gio.DBus.session.signal_subscribe(
            BUS_NAME, INTERFACE_NAME, 'AgentEvent', OBJECT_PATH, null, Gio.DBusSignalFlags.NONE,
            (_connection, _sender, _path, _iface, _signal, parameters) => {
                const [fields] = parameters.deepUnpack() as [Record<string, string>];
                this.onAgentEvent(fields);
            });

        const gjs = GLib.find_program_in_path('gjs');
        if (!gjs) {
            console.error('Islet: gjs was not found in PATH, so the daemon cannot start');
            return;
        }

        const process = Gio.Subprocess.new([gjs, '-m', this.daemonPath], Gio.SubprocessFlags.NONE);
        this.process = process;
        process.wait_async(this.cancellable, (_source, result) => {
            try {
                process.wait_finish(result);
            } catch {
                return; // Cancelled by stop().
            }
            if (this.process !== process)
                return;
            this.process = null;
            const how = process.get_if_exited() ? `status ${process.get_exit_status()}` : 'a signal';
            console.warn(`Islet: the daemon exited with ${how}`);
        });
    }

    reportAgentEvent(fields: Record<string, string>): void {
        Gio.DBus.session.call(
            BUS_NAME, OBJECT_PATH, INTERFACE_NAME, 'ReportAgentEvent',
            new GLib.Variant('(a{ss})', [fields]), null,
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, this.cancellable,
            (connection, result) => {
                try {
                    connection?.call_finish(result);
                } catch (error) {
                    if (!this.cancellable.is_cancelled())
                        console.warn(`Islet: could not reach the daemon: ${error}`);
                }
            });
    }

    stop(): void {
        this.cancellable.cancel();
        if (this.signalId) {
            Gio.DBus.session.signal_unsubscribe(this.signalId);
            this.signalId = 0;
        }
        this.process?.send_signal(SIGTERM);
        this.process = null;
    }
}
