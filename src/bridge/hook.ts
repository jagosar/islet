// islet-hook: a Claude Code command hook, run as `gjs -m bridge/hook.js` with the event JSON on
// stdin. It forwards a few whitelisted fields to the daemon.
//
// It must never affect Claude Code: it prints nothing and exits 0 in every case (a Stop hook
// that exits 2 would keep Claude from stopping), and gives up after a short D-Bus timeout.

import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';

import {BUS_NAME, INTERFACE_NAME, OBJECT_PATH} from '../core/dbus.js';
import {hookFieldsFromJson} from '../core/hookInput.js';

const CALL_TIMEOUT_MS = 200;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Reads stdin through file descriptor 0. Opening /dev/stdin fails with ENXIO when stdin is a
 * socket, which is how the Claude desktop app passes hook input (the terminal uses a pipe).
 */
function readStdin(): string {
    const stream = new GioUnix.InputStream({fd: 0, close_fd: false});
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const chunk = stream.read_bytes(64 * 1024, null).toArray();
        if (chunk.length === 0)
            break;
        total += chunk.length;
        if (total > MAX_INPUT_BYTES)
            throw new Error('hook input is too large');
        chunks.push(chunk);
    }

    // GJS's TextDecoder has no streaming mode, so decode once at the end.
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return new TextDecoder().decode(bytes);
}

try {
    const fields = hookFieldsFromJson(readStdin());
    if (fields) {
        Gio.DBus.session.call_sync(
            BUS_NAME, OBJECT_PATH, INTERFACE_NAME, 'ReportAgentEvent',
            new GLib.Variant('(a{ss})', [fields]), null,
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, null);
    }
} catch (error) {
    // Islet is not running or the input was unexpected: nothing to report. Development tools
    // set ISLET_HOOK_DEBUG to see why; stderr is not shown to Claude for an exit code of 0.
    if (GLib.getenv('ISLET_HOOK_DEBUG'))
        printerr(`islet-hook: ${error}`);
}
