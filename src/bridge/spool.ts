// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    MAX_SPOOL_ENTRIES, PLAN_SPOOL_FILE, encodeSpoolEntry, isSpoolFileName, spoolFileName, type SpoolEntry,
} from '../core/spool.js';

export function spoolDirectory(): string {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'islet', 'spool']);
}

/**
 * Leaves an entry for the daemon to replay when it starts. Best effort: a hook must never fail
 * or block Claude Code, so without a runtime directory (or room) the entry is simply dropped.
 * Files are written atomically (temporary file and rename) and are private to the user.
 */
export function spool(entry: SpoolEntry): void {
    try {
        const dir = spoolDirectory();
        GLib.mkdir_with_parents(dir, 0o700);

        let name = PLAN_SPOOL_FILE; // Only the latest plan usage matters: it overwrites itself.
        if (entry.kind === 'agent-event') {
            const files = Gio.File.new_for_path(dir).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let count = 0;
            for (let info = files.next_file(null); info; info = files.next_file(null)) {
                if (isSpoolFileName(info.get_name()))
                    count++;
            }
            files.close(null);
            if (count >= MAX_SPOOL_ENTRIES)
                return;
            name = spoolFileName(entry.at, Math.floor(Math.random() * 1_000_000), 'agent-event');
        }

        GLib.file_set_contents_full(GLib.build_filenamev([dir, name]), encodeSpoolEntry(entry), GLib.FileSetContentsFlags.NONE, 0o600);
    } catch {
        // Nowhere to spool: nothing more to do.
    }
}
