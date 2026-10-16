// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

/**
 * A Unix time formatted in the local time zone ("%H:%M", "%Y-%m-%d"). GLib returns null for
 * times it cannot represent, which its TypeScript types do not say, so null becomes ''.
 */
export function formatLocal(epochSeconds: number, format: string): string {
    return (GLib.DateTime.new_from_unix_local(epochSeconds) as GLib.DateTime | null)?.format(format) ?? '';
}
