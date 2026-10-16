// SPDX-License-Identifier: GPL-2.0-or-later

import GioUnix from 'gi://GioUnix';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;

/**
 * Reads stdin through file descriptor 0. Opening /dev/stdin fails with ENXIO when stdin is a
 * socket, which is how the Claude desktop app passes hook input (the terminal uses a pipe).
 * Throws when the input is larger than 8 MiB.
 */
export function readStdinBytes(): Uint8Array {
    const stream = new GioUnix.InputStream({fd: 0, close_fd: false});
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const chunk = stream.read_bytes(64 * 1024, null).toArray();
        if (chunk.length === 0)
            break;
        total += chunk.length;
        if (total > MAX_INPUT_BYTES)
            throw new Error('input is too large');
        chunks.push(chunk);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return bytes;
}

/** GJS's TextDecoder has no streaming mode, so the bytes are decoded once, at the end. */
export function readStdin(): string {
    return new TextDecoder().decode(readStdinBytes());
}
