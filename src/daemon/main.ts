// islet-daemon: run by the extension as `gjs -m daemon/main.js`.
//
// Lifecycle rules (no orphans, newest wins):
// - The bus name is owned with ALLOW_REPLACEMENT | REPLACE, so a newly started daemon takes
//   over and the previous one exits when it loses the name.
// - Losing the name or the bus connection ends the process.
// - When org.gnome.Shell leaves the bus, the daemon exits too.
// - SIGTERM (sent by the extension's disable()) keeps its default action: exit.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseAgentEvent} from '../core/agentEvents.js';
import {BUS_NAME, INTERFACE_XML, OBJECT_PATH} from '../core/dbus.js';

const loop = new GLib.MainLoop(null, false);
let exported: Gio.DBusExportedObject | null = null;

const service = {
    ReportAgentEvent(fields: Record<string, string>): void {
        if (!parseAgentEvent(fields)) {
            console.warn('islet-daemon: ignored an invalid agent event');
            return;
        }
        exported?.emit_signal('AgentEvent', new GLib.Variant('(a{ss})', [fields]));
    },
};

Gio.bus_own_name(
    Gio.BusType.SESSION,
    BUS_NAME,
    Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
    connection => {
        exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, service);
        exported.export(connection, OBJECT_PATH);
    },
    null,
    () => {
        console.log('islet-daemon: bus name lost, exiting');
        loop.quit();
    });

Gio.bus_watch_name(
    Gio.BusType.SESSION,
    'org.gnome.Shell',
    Gio.BusNameWatcherFlags.NONE,
    null,
    () => {
        console.log('islet-daemon: GNOME Shell left the bus, exiting');
        loop.quit();
    });

// The object and the name go away with the bus connection when the process exits.
loop.run();
