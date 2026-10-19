// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {PlanSample} from '../core/planEstimate.js';
import {DESKTOP_HISTORY_FILE, parseDesktopPlanHistory, parseDesktopPlanSamples} from '../core/planSources.js';
import type {IsletService} from './service.js';

/** The app rewrites the file in one go; read once it settles. */
const DEBOUNCE_MS = 500;
/** The history is a few kilobytes; anything far larger is not the file Islet knows. */
const MAX_BYTES = 1024 * 1024;
/** While the desktop app's folder does not exist (it is not installed yet), look for it this often. */
const MISSING_FOLDER_RETRY_S = 300;

/** $XDG_CONFIG_HOME/Claude/plan-usage-history.json, where the Claude desktop app keeps it. */
export function desktopHistoryPath(): string {
    return GLib.build_filenamev([GLib.get_user_config_dir(), 'Claude', DESKTOP_HISTORY_FILE]);
}

/**
 * Follows the plan usage the Claude desktop app records locally (it fetches it from Anthropic
 * while it runs), so the plan bars work for people who never use a terminal session. Read only:
 * the file is the desktop app's, and nothing else in its folder is opened.
 */
export class DesktopPlanModule {
    private monitor: Gio.FileMonitor | null = null;
    private debounceId = 0;
    private retryId = 0;
    private history: PlanSample[] = [];

    /** `onChange` runs after each read of the history (the estimator listens to it). */
    constructor(
        private readonly service: IsletService,
        private readonly path = desktopHistoryPath(),
        private readonly onChange: () => void = () => undefined,
    ) {}

    /** The samples of the history, oldest first. */
    get samples(): readonly PlanSample[] {
        return this.history;
    }

    start(): void {
        const folder = GLib.path_get_dirname(this.path);
        const name = GLib.path_get_basename(this.path);
        // The folder is watched, not the file: apps replace such files by renaming a new one
        // over them, which a file monitor does not report reliably. A missing folder means the
        // app is not installed (yet): look for it again later.
        if (!GLib.file_test(folder, GLib.FileTest.IS_DIR)) {
            this.retryId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, MISSING_FOLDER_RETRY_S, () => {
                this.retryId = 0;
                this.start();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        try {
            this.monitor = Gio.File.new_for_path(folder).monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, null);
            this.monitor.connect('changed', (_monitor, file, other) => {
                if (file.get_basename() === name || other?.get_basename() === name)
                    this.schedule();
            });
        } catch (error) {
            console.warn(`islet-daemon: cannot watch the desktop app's plan history: ${String(error)}`);
        }
        this.read();
    }

    private schedule(): void {
        if (this.debounceId)
            GLib.source_remove(this.debounceId);
        this.debounceId = GLib.timeout_add(GLib.PRIORITY_LOW, DEBOUNCE_MS, () => {
            this.debounceId = 0;
            this.read();
            return GLib.SOURCE_REMOVE;
        });
    }

    private read(): void {
        let text: string;
        try {
            const file = Gio.File.new_for_path(this.path);
            if (file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size() > MAX_BYTES)
                return;
            const [, bytes] = file.load_contents(null);
            text = new TextDecoder().decode(bytes);
        } catch {
            return; // No desktop app, or the file is being replaced: the next change reads it.
        }
        this.history = parseDesktopPlanSamples(text) ?? [];
        const plan = parseDesktopPlanHistory(text);
        if (plan)
            this.service.reportPlanReading(plan);
        this.onChange();
    }
}
