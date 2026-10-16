// islet-hook: a Claude Code command hook, run as `gjs -m bridge/hook.js` with the event JSON on
// stdin. It forwards a few whitelisted fields to the daemon.
//
// It must never affect Claude Code: it prints nothing and exits 0 in every case (a Stop hook
// that exits 2 would keep Claude from stopping), and gives up after a short D-Bus timeout.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {BUS_NAME, INTERFACE_NAME, OBJECT_PATH} from '../core/dbus.js';
import {hookFieldsFromJson} from '../core/hookInput.js';

const CALL_TIMEOUT_MS = 200;

try {
    const [, bytes] = GLib.file_get_contents('/dev/stdin');
    const fields = hookFieldsFromJson(new TextDecoder().decode(bytes));
    if (fields) {
        Gio.DBus.session.call_sync(
            BUS_NAME, OBJECT_PATH, INTERFACE_NAME, 'ReportAgentEvent',
            new GLib.Variant('(a{ss})', [fields]), null,
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, null);
    }
} catch {
    // Islet is not running or the input was unexpected: nothing to report.
}
