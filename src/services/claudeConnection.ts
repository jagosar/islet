// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    connectSettings, connectionStatus, disconnectSettings, plannedEntries, repairSettings, sameSettings, type ConnectionStatus,
} from '../core/claudeSettings.js';

/**
 * Reads and writes Claude Code's settings.json for the preferences window and the uninstaller
 * (both run outside GNOME Shell, so synchronous file access is fine here).
 *
 * Connecting saves the original file as settings.json.islet-backup. Disconnecting restores
 * those exact bytes when nothing else changed meanwhile, and otherwise removes only Islet's
 * entries. Writes go through a temporary file and a rename, keeping the file's permissions.
 */
export class ClaudeConnection {
    readonly path: string;
    private readonly backupPath: string;

    constructor(private readonly extensionDir: string) {
        const config = GLib.getenv('CLAUDE_CONFIG_DIR') ?? GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        this.path = GLib.build_filenamev([config, 'settings.json']);
        this.backupPath = `${this.path}.islet-backup`;
    }

    /** The path with the home directory shown as ~, for display. */
    get displayPath(): string {
        const home = GLib.get_home_dir();
        return this.path.startsWith(`${home}/`) ? `~${this.path.slice(home.length)}` : this.path;
    }

    status(): ConnectionStatus {
        this.tightenBackup();
        return connectionStatus(this.read(this.path), this.scripts());
    }

    /** The JSON connect() would add, pretty-printed, for the confirmation dialog. Throws SettingsError. */
    preview(): string {
        return JSON.stringify(plannedEntries(this.read(this.path), this.scripts()), null, 2);
    }

    /** Throws SettingsError (invalid settings) or GLib errors (I/O). */
    connect(): void {
        this.tightenBackup();
        const original = this.read(this.path);
        const connected = connectSettings(original, this.scripts());
        if (connected === original)
            return;
        if (original !== null && !GLib.file_test(this.backupPath, GLib.FileTest.EXISTS))
            this.write(this.backupPath, original);
        GLib.mkdir_with_parents(GLib.path_get_dirname(this.path), 0o700);
        this.write(this.path, connected);
    }

    /**
     * Makes a connection current when it is stale (the extension moved, an event is missing, or
     * it was made by an older version). Throws SettingsError (invalid settings) or GLib errors.
     */
    repair(): void {
        this.tightenBackup();
        const original = this.read(this.path);
        const repaired = repairSettings(original, this.scripts());
        if (repaired === original)
            return;
        if (original !== null && !GLib.file_test(this.backupPath, GLib.FileTest.EXISTS))
            this.write(this.backupPath, original);
        this.write(this.path, repaired);
    }

    /** Throws SettingsError (invalid settings) or GLib errors (I/O). */
    disconnect(): void {
        const current = this.read(this.path);
        if (current === null)
            return;
        const disconnected = disconnectSettings(current);
        const backup = this.read(this.backupPath);

        if (backup !== null && sameSettings(disconnected, backup))
            this.write(this.path, backup);
        else if (backup === null && sameSettings(disconnected, '{}'))
            Gio.File.new_for_path(this.path).delete(null); // Islet created the file.
        else
            this.write(this.path, disconnected);

        if (backup !== null)
            Gio.File.new_for_path(this.backupPath).delete(null);
    }

    private scripts() {
        return {
            hook: GLib.build_filenamev([this.extensionDir, 'bridge', 'hook.js']),
            statusLine: GLib.build_filenamev([this.extensionDir, 'bridge', 'statusline.js']),
        };
    }

    private read(path: string): string | null {
        try {
            const [, bytes] = GLib.file_get_contents(path);
            return new TextDecoder().decode(bytes);
        } catch {
            return null;
        }
    }

    /**
     * settings.json can hold secrets (an API key in `env`), so a file created here is private.
     * Replacing an existing file keeps its permissions; the backup version 0.1.0 created was
     * world-readable, so an existing one is tightened.
     */
    private write(path: string, text: string): void {
        Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(text), null, false, Gio.FileCreateFlags.PRIVATE, null);
    }

    private tightenBackup(): void {
        const file = Gio.File.new_for_path(this.backupPath);
        if (!file.query_exists(null))
            return;
        const mode = file.query_info('unix::mode', Gio.FileQueryInfoFlags.NONE, null).get_attribute_uint32('unix::mode');
        if ((mode & 0o077) !== 0)
            GLib.chmod(this.backupPath, 0o600);
    }
}
