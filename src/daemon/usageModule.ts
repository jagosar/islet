// SPDX-License-Identifier: GPL-2.0-or-later
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {UsageAggregator, dayKey} from '../core/usage/aggregator.js';
import {mayHoldUsage, parseCostStateLine, parseUsageLine} from '../core/usage/claudeTranscript.js';
import {HISTORY_DAYS, buildUsageSnapshot} from '../core/usage/snapshot.js';
import type {IsletService} from './service.js';

/** Work per idle slice while scanning, so D-Bus calls are still answered quickly. */
const SLICE_MS = 20;
/** Claude Code writes a reply in several appends; read once they settle. */
const DEBOUNCE_MS = 300;
/** While ~/.claude/projects does not exist yet, look for it this often. */
const MISSING_ROOT_RETRY_S = 300;

interface Cursor {
    inode: string;
    offset: number;
}

/** $CLAUDE_CONFIG_DIR/projects, or ~/.claude/projects. */
export function projectsRoot(): string {
    const config = GLib.getenv('CLAUDE_CONFIG_DIR') ?? GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
    return GLib.build_filenamev([config, 'projects']);
}

function localTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Keeps the Usage property current from Claude Code's transcripts.
 *
 * On start it reads every transcript changed in the last 26 weeks, in small idle slices; then it
 * reads only what is appended, from a byte cursor per file. Nothing about usage is persisted:
 * totals are rebuilt from the transcripts, so they can never drift from them. Only metadata
 * lines are parsed (see mayHoldUsage), never message content.
 */
export class UsageModule {
    private readonly aggregator = new UsageAggregator(localTimeZone());
    private readonly timeZone = localTimeZone();
    private readonly cursors = new Map<string, Cursor>();
    private readonly monitors = new Map<string, Gio.FileMonitor>();
    private readonly pending = new Set<string>();
    private readonly queue: string[] = [];
    private sliceId = 0;
    private debounceId = 0;
    private midnightId = 0;
    private retryId = 0;
    private published = '';

    constructor(
        private readonly service: IsletService,
        private readonly root = projectsRoot(),
    ) {}

    start(): void {
        if (!GLib.file_test(this.root, GLib.FileTest.IS_DIR)) {
            this.retryId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, MISSING_ROOT_RETRY_S, () => {
                this.retryId = 0;
                this.start();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        const cutoff = GLib.get_real_time() / 1_000_000 - (HISTORY_DAYS + 1) * 86400;
        this.watchTree(this.root, cutoff);
        this.scheduleMidnight();
        this.drain();
    }

    /** Watches `dir` and every directory below it, and queues the transcripts changed after `cutoff`. */
    private watchTree(dir: string, cutoff: number): void {
        if (this.monitors.has(dir))
            return;
        let enumerator: Gio.FileEnumerator;
        try {
            const monitor = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            monitor.connect('changed', (_monitor, file, _other, event) => this.onChanged(file, event));
            this.monitors.set(dir, monitor);
            enumerator = Gio.File.new_for_path(dir).enumerate_children(
                'standard::name,standard::type,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        } catch (error) {
            console.warn(`islet-daemon: cannot watch a transcript folder: ${error}`);
            return;
        }

        for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
            const path = GLib.build_filenamev([dir, info.get_name()]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                this.watchTree(path, cutoff);
            else if (path.endsWith('.jsonl') && info.get_attribute_uint64('time::modified') >= cutoff)
                this.enqueue(path);
        }
        enumerator.close(null);
    }

    private onChanged(file: Gio.File, event: Gio.FileMonitorEvent): void {
        const path = file.get_path();
        if (!path)
            return;
        switch (event) {
        case Gio.FileMonitorEvent.CREATED:
        case Gio.FileMonitorEvent.MOVED_IN:
            if (GLib.file_test(path, GLib.FileTest.IS_DIR)) {
                this.watchTree(path, 0);
                this.drain();
                return;
            }
            break;
        case Gio.FileMonitorEvent.CHANGED:
        case Gio.FileMonitorEvent.CHANGES_DONE_HINT:
            break;
        case Gio.FileMonitorEvent.DELETED:
        case Gio.FileMonitorEvent.MOVED_OUT:
            // Counted usage stays; a deleted transcript is not "un-used".
            this.cursors.delete(path);
            this.monitors.get(path)?.cancel();
            this.monitors.delete(path);
            return;
        default:
            return;
        }
        if (!path.endsWith('.jsonl'))
            return;

        this.pending.add(path);
        if (this.debounceId)
            GLib.source_remove(this.debounceId);
        this.debounceId = GLib.timeout_add(GLib.PRIORITY_LOW, DEBOUNCE_MS, () => {
            this.debounceId = 0;
            for (const pending of this.pending)
                this.enqueue(pending);
            this.pending.clear();
            this.drain();
            return GLib.SOURCE_REMOVE;
        });
    }

    private enqueue(path: string): void {
        if (!this.queue.includes(path))
            this.queue.push(path);
    }

    /** Reads queued files in idle slices, then publishes once. */
    private drain(): void {
        if (this.sliceId)
            return;
        this.sliceId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const deadline = GLib.get_monotonic_time() + SLICE_MS * 1000;
            while (this.queue.length && GLib.get_monotonic_time() < deadline)
                this.readNew(this.queue.shift()!);
            if (this.queue.length)
                return GLib.SOURCE_CONTINUE;
            this.sliceId = 0;
            this.publish();
            // Reading leaves megabytes of decoded text behind; collect it now rather than
            // whenever the engine next decides to, so the daemon stays small while idle.
            System.gc();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Reads the complete lines appended since the file's cursor. */
    private readNew(path: string): void {
        const file = Gio.File.new_for_path(path);
        try {
            const info = file.query_info('standard::size,unix::inode', Gio.FileQueryInfoFlags.NONE, null);
            const size = info.get_size();
            const inode = String(info.get_attribute_uint64('unix::inode'));

            let cursor = this.cursors.get(path);
            if (!cursor || cursor.inode !== inode || size < cursor.offset) {
                // New, replaced or truncated: read from the start. Responses already counted are
                // recognised by their message id.
                cursor = {inode, offset: 0};
                this.cursors.set(path, cursor);
            }
            if (size === cursor.offset)
                return;

            // Line by line: decoding large chunks into strings kept ~190 MB of a 200 MB history
            // resident; reading lines peaks below 50 MB at the same speed (issue #16).
            const raw = file.read(null);
            raw.seek(cursor.offset, GLib.SeekType.SET, null);
            const stream = new Gio.DataInputStream({base_stream: raw});
            for (;;) {
                const [line, length] = stream.read_line_utf8(null);
                if (line === null)
                    break;
                // A last line without its newline yet is partial: leave it for the next read.
                // (size is from before reading, so a line that grew past it is left too.)
                if (cursor.offset + length + 1 > size)
                    break;
                cursor.offset += length + 1;
                this.readLine(line);
            }
            stream.close(null);
        } catch (error) {
            console.warn(`islet-daemon: cannot read a transcript: ${error}`);
        }
    }

    private readLine(line: string): void {
        if (!mayHoldUsage(line))
            return;
        const record = parseUsageLine(line);
        if (record) {
            this.aggregator.add(record);
            return;
        }
        const costState = parseCostStateLine(line);
        if (costState)
            this.aggregator.setSessionReference(costState.sessionId, costState.models);
    }

    private publish(): void {
        const today = dayKey(new Date().toISOString(), this.timeZone);
        const snapshot = buildUsageSnapshot(this.aggregator.byDay(), today);
        const text = JSON.stringify(snapshot);
        if (text === this.published)
            return;
        this.published = text;
        this.service.setUsage(snapshot);
    }

    /** "Today" changes at local midnight even when nothing is written. */
    private scheduleMidnight(): void {
        const now = GLib.DateTime.new_now_local();
        const tomorrow = now.add_days(1)!;
        const midnight = GLib.DateTime.new_local(tomorrow.get_year(), tomorrow.get_month(), tomorrow.get_day_of_month(), 0, 0, 1);
        const seconds = Math.max(1, Math.ceil(Number(midnight.difference(now)) / 1_000_000));
        this.midnightId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, seconds, () => {
            this.midnightId = 0;
            this.publish();
            this.scheduleMidnight();
            return GLib.SOURCE_REMOVE;
        });
    }
}
