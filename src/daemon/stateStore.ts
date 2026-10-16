// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

/**
 * Small JSON files in $XDG_STATE_HOME/islet. Writes are atomic (temporary file and rename), so
 * a crash never leaves a half-written file; a missing or unreadable file reads as null.
 */
export class StateStore {
    private readonly dir: string;

    constructor(dir = GLib.build_filenamev([GLib.get_user_state_dir(), 'islet'])) {
        this.dir = dir;
    }

    read(name: string): string | null {
        try {
            const [, bytes] = GLib.file_get_contents(this.path(name));
            return new TextDecoder().decode(bytes);
        } catch {
            return null;
        }
    }

    write(name: string, text: string): void {
        try {
            GLib.mkdir_with_parents(this.dir, 0o700);
            Gio.File.new_for_path(this.path(name)).replace_contents(
                new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.PRIVATE, null);
        } catch (error) {
            console.warn(`islet-daemon: could not save ${name}: ${error}`);
        }
    }

    private path(name: string): string {
        return GLib.build_filenamev([this.dir, name]);
    }
}
