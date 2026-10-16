// SPDX-License-Identifier: GPL-2.0-or-later
// A tiny D-Bus client for the integration tests, run with gjs against a private session bus:
//
//   gjs -m client.js get PROPERTY              prints the property's JSON text
//   gjs -m client.js call METHOD JSON_ARGS     calls a method (a{ss} or a{sd}, from a JSON object)
//   gjs -m client.js watch SECONDS             prints every AgentEvent signal as one JSON line
//   gjs -m client.js watch-properties SECONDS  prints the name of every changed property
//   gjs -m client.js flood-events N            sends N agent events, each from a new session
//   gjs -m client.js flood-plan N JSON_FIELDS  reports the same plan usage N times
//   gjs -m client.js ping                      exits 0 once the daemon owns its bus name
//
// Exit codes: 0 ok, 1 error (message on stderr).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const NAME = 'io.github.jagosar.Islet';
const PATH = '/io/github/jagosar/Islet';
const IFACE = 'io.github.jagosar.Islet1';
const [command, ...args] = System.programArgs;

function fail(message) {
    printerr(message);
    System.exit(1);
}

const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);

try {
    switch (command) {
    case 'ping': {
        const reply = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameHasOwner',
            new GLib.Variant('(s)', [NAME]), null, Gio.DBusCallFlags.NONE, 2000, null);
        System.exit(reply.deepUnpack()[0] ? 0 : 1);
        break;
    }
    case 'get': {
        const reply = bus.call_sync(NAME, PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [IFACE, args[0]]), null, Gio.DBusCallFlags.NONE, 5000, null);
        print(reply.deepUnpack()[0].deepUnpack());
        break;
    }
    case 'call': {
        const fields = JSON.parse(args[1] ?? '{}');
        const signature = args[0] === 'ReportPlanUsage' ? 'a{sd}' : 'a{ss}';
        bus.call_sync(NAME, PATH, IFACE, args[0], new GLib.Variant(`(${signature})`, [fields]), null, Gio.DBusCallFlags.NONE, 5000, null);
        break;
    }
    case 'watch': {
        const loop = new GLib.MainLoop(null, false);
        bus.signal_subscribe(NAME, IFACE, 'AgentEvent', PATH, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, parameters) => print(JSON.stringify(parameters.deepUnpack()[0])));
        print('ready');
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Number(args[0] ?? 5), () => {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
        loop.run();
        break;
    }
    case 'watch-properties': {
        const loop = new GLib.MainLoop(null, false);
        bus.signal_subscribe(NAME, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', PATH, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, parameters) => {
                for (const name of Object.keys(parameters.deepUnpack()[1]))
                    print(name);
            });
        print('ready');
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Number(args[0] ?? 5), () => {
            loop.quit();
            return GLib.SOURCE_REMOVE;
        });
        loop.run();
        break;
    }
    case 'flood-events': {
        const count = Number(args[0]);
        for (let i = 0; i < count; i++) {
            bus.call_sync(NAME, PATH, IFACE, 'ReportAgentEvent',
                new GLib.Variant('(a{ss})', [{session_id: `flood-${i}`, cwd: '/home/me/code/flood', hook_event_name: 'UserPromptSubmit'}]),
                null, Gio.DBusCallFlags.NONE, 5000, null);
        }
        break;
    }
    case 'flood-plan': {
        const fields = JSON.parse(args[1]);
        for (let i = 0; i < Number(args[0]); i++) {
            bus.call_sync(NAME, PATH, IFACE, 'ReportPlanUsage', new GLib.Variant('(a{sd})', [fields]), null, Gio.DBusCallFlags.NONE, 5000, null);
        }
        break;
    }
    default:
        fail('usage: client.js get|call|watch|watch-properties|flood-events|flood-plan|ping');
    }
} catch (error) {
    fail(String(error));
}
