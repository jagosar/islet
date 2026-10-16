// SPDX-License-Identifier: GPL-2.0-or-later

// islet-statusline: a Claude Code status line command, run as
// `gjs -m bridge/statusline.js [PREVIOUS]` with the session JSON on stdin.
//
// It sends the plan figures (5-hour and 7-day windows) to the daemon, then prints the status
// line: the output of the user's own previous status line command when there was one (PREVIOUS,
// base64), so nothing visible changes, or else a short "5h 33% · 7d 4%".
//
// Like the hook bridge it never fails visibly: D-Bus errors are ignored, and the previous
// command gets 5 seconds before it is stopped.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {BUS_NAME, INTERFACE_NAME, OBJECT_PATH} from '../core/dbus.js';
import {formatPlanStatusLine, planReportFromStatusLine} from '../core/statusLine.js';
import {spool} from './spool.js';
import {readStdinBytes} from './stdin.js';

const CALL_TIMEOUT_MS = 200;
const PREVIOUS_TIMEOUT_MS = 5000;

function reportPlanUsage(report: Record<string, number>): void {
    try {
        Gio.DBus.session.call_sync(
            BUS_NAME, OBJECT_PATH, INTERFACE_NAME, 'ReportPlanUsage',
            new GLib.Variant('(a{sd})', [report]), null,
            Gio.DBusCallFlags.NO_AUTO_START, CALL_TIMEOUT_MS, null);
    } catch {
        // Islet is not running: the status line still works, and the daemon will pick the figures
        // up from the spool when it starts.
        spool({kind: 'plan-usage', at: GLib.get_real_time() / 1_000_000, fields: report});
    }
}

/**
 * Runs the user's previous status line command with the same stdin; returns its stdout.
 *
 * The input goes through a temporary file, not a pipe: a command that never reads its stdin
 * (`printf hello`) exits before a pipe write completes, the write fails with EPIPE, and the
 * command's output would be lost with it.
 */
function runPrevious(command: string, input: Uint8Array): string {
    const [fd, inputPath] = GLib.file_open_tmp('islet-statusline-XXXXXX');
    GLib.close(fd);
    GLib.file_set_contents(inputPath, input);

    const loop = new GLib.MainLoop(null, false);
    const cancellable = new Gio.Cancellable();
    // Stderr is discarded: a command that leaves a background process behind would otherwise
    // keep Claude Code's stderr pipe open and stall it. `timeout` ends the command's whole process
    // group at the deadline, so a hanging status line cannot pile up orphans (one per refresh).
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE});
    launcher.set_stdin_file_path(inputPath);
    const guard = GLib.find_program_in_path('timeout');
    const process = launcher.spawnv(guard
        ? [guard, '--kill-after=1', String(PREVIOUS_TIMEOUT_MS / 1000), 'sh', '-c', command]
        : ['sh', '-c', command]);
    let output = '';

    const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREVIOUS_TIMEOUT_MS + 1500, () => {
        cancellable.cancel();
        process.force_exit();
        // Stop waiting now: a grandchild (e.g. `sleep`) can keep the pipe open after `sh` dies.
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    process.communicate_async(null, cancellable, (_process, result) => {
        try {
            const [, stdout] = process.communicate_finish(result);
            output = stdout ? new TextDecoder().decode(stdout.toArray()) : '';
        } catch {
            output = '';
        }
        loop.quit();
    });
    loop.run();
    if (!cancellable.is_cancelled())
        GLib.source_remove(timeoutId);
    GLib.unlink(inputPath);
    return output;
}

let input: Uint8Array = new Uint8Array(0);
try {
    input = readStdinBytes();
} catch {
    // Unreadable or oversized input: print what we can.
}

const report = planReportFromStatusLine(new TextDecoder().decode(input));
if (report)
    reportPlanUsage(report);

const encodedPrevious = System.programArgs[0] ?? '';
const previous = encodedPrevious ? new TextDecoder().decode(GLib.base64_decode(encodedPrevious)) : '';
const line = previous ? runPrevious(previous, input).replace(/\n$/, '') : formatPlanStatusLine(report);
if (line)
    print(line);
