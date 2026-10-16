// SPDX-License-Identifier: GPL-2.0-or-later

// islet-daemon: run by the extension as `gjs -m daemon/main.js`.
//
// Lifecycle rules (no orphans, newest wins):
// - The bus name is owned with ALLOW_REPLACEMENT | REPLACE, so a newly started daemon takes
//   over and the previous one exits when it loses the name.
// - Losing the name or the bus connection ends the process.
// - When org.gnome.Shell leaves the bus, the daemon exits too (unless ISLET_STANDALONE is set).
// - SIGTERM (sent by the extension's disable()) keeps its default action: exit. Sessions are
//   saved as they change, so nothing is pending at that point.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME} from '../core/dbus.js';
import {IsletService} from './service.js';
import {SessionsModule} from './sessionsModule.js';
import {SpoolModule} from './spoolModule.js';
import {StateStore} from './stateStore.js';
import {UsageModule} from './usageModule.js';

const loop = new GLib.MainLoop(null, false);
const store = new StateStore();
const service = new IsletService(store);
new SessionsModule(service, store);
new UsageModule(service).start();
// After the sessions were restored: replayed events apply on top of them.
new SpoolModule(service).start();


Gio.bus_own_name(
    Gio.BusType.SESSION,
    BUS_NAME,
    Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
    (connection: Gio.DBusConnection) => { service.export(connection); },
    null,
    () => {
        console.log('islet-daemon: bus name lost, exiting');
        loop.quit();
    });

// ISLET_STANDALONE is for tests and debugging outside GNOME Shell: there is no org.gnome.Shell
// on the bus then, so the daemon must not exit because of its absence.
if (!GLib.getenv('ISLET_STANDALONE')) {
    Gio.bus_watch_name(
        Gio.BusType.SESSION,
        'org.gnome.Shell',
        Gio.BusNameWatcherFlags.NONE,
        null,
        () => {
            console.log('islet-daemon: GNOME Shell left the bus, exiting');
            loop.quit();
        });
}

// The object and the name go away with the bus connection when the process exits.
loop.run();
