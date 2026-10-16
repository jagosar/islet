// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    decodeSpoolEntry, isSpoolFileName, selectSpoolEntries, type NamedEntry,
} from '../core/spool.js';
import type {IsletService} from './service.js';

const DEBOUNCE_MS = 100;

/** $XDG_RUNTIME_DIR/islet/spool, where the bridges leave what the daemon was not there to receive. */
export function spoolDirectory(): string {
    return GLib.build_filenamev([GLib.get_user_runtime_dir(), 'islet', 'spool']);
}

/**
 * Replays the spool (see core/spool.ts) when the daemon starts, and whenever a bridge leaves
 * something while it runs (a bridge can lose a race with the daemon's start). Replayed events
 * update the state with their own times but raise no live activity: they are not news.
 * Files that are not ours are left alone; stale, damaged and replayed ones are deleted.
 */
export class SpoolModule {
    private debounceId = 0;
    private monitor: Gio.FileMonitor | null = null;

    constructor(
        private readonly service: IsletService,
        private readonly dir = spoolDirectory(),
    ) {}

    start(): void {
        try {
            GLib.mkdir_with_parents(this.dir, 0o700);
            this.monitor = Gio.File.new_for_path(this.dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this.monitor.connect('changed', (_monitor, file) => {
                const name = file.get_basename();
                if (name && isSpoolFileName(name))
                    this.scheduleDrain();
            });
        } catch (error) {
            console.warn(`islet-daemon: cannot watch the spool: ${String(error)}`);
        }
        this.drain();
    }

    private scheduleDrain(): void {
        if (this.debounceId)
            GLib.source_remove(this.debounceId);
        this.debounceId = GLib.timeout_add(GLib.PRIORITY_LOW, DEBOUNCE_MS, () => {
            this.debounceId = 0;
            this.drain();
            return GLib.SOURCE_REMOVE;
        });
    }

    private drain(): void {
        const dir = Gio.File.new_for_path(this.dir);
        const entries: NamedEntry[] = [];
        const unreadable: string[] = [];
        try {
            const files = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            for (let info = files.next_file(null); info; info = files.next_file(null)) {
                const name = info.get_name();
                if (!isSpoolFileName(name))
                    continue;
                try {
                    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([this.dir, name]));
                    const entry = decodeSpoolEntry(new TextDecoder().decode(bytes));
                    if (entry)
                        entries.push({name, entry});
                    else
                        unreadable.push(name);
                } catch {
                    unreadable.push(name);
                }
            }
            files.close(null);
        } catch {
            return; // No spool directory: nothing was left.
        }

        const now = GLib.get_real_time() / 1_000_000;
        const {use, discard} = selectSpoolEntries(entries, now);
        for (const {entry} of use) {
            if (entry.kind === 'agent-event')
                this.service.replayAgentEvent(entry.fields, entry.at);
            else
                this.service.replayPlanUsage(entry.fields, entry.at);
        }
        for (const name of [...unreadable, ...use.map(item => item.name), ...discard.map(item => item.name)])
            GLib.unlink(GLib.build_filenamev([this.dir, name]));
    }
}
