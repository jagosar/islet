// SPDX-License-Identifier: GPL-2.0-or-later
/** Now playing, from MPRIS players. Pure: the Shell side feeds it unpacked D-Bus properties. */

export type PlaybackStatus = 'Playing' | 'Paused' | 'Stopped';

export interface MediaPlayer {
    busName: string;
    status: PlaybackStatus;
    title: string;
    artist: string;
    /** A file:// URL, or '' (remote artwork is not fetched). */
    artUrl: string;
    canGoNext: boolean;
    canGoPrevious: boolean;
    canPlayPause: boolean;
    /** Monotonic milliseconds of the last change, to pick a player when none is playing. */
    changedAt: number;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads the parts of an MPRIS Metadata dictionary (already unpacked) that Islet shows:
 * xesam:title, xesam:artist (a list) and mpris:artUrl (local files only).
 */
export function readMetadata(metadata: Record<string, unknown>): {title: string; artist: string; artUrl: string} {
    const artists = metadata['xesam:artist'];
    const artist = Array.isArray(artists) ? artists.map(text).filter(Boolean).join(', ') : text(artists);
    const artUrl = text(metadata['mpris:artUrl']);
    return {
        title: text(metadata['xesam:title']),
        artist,
        artUrl: artUrl.startsWith('file://') ? artUrl : '',
    };
}

export function readStatus(value: unknown): PlaybackStatus {
    return value === 'Playing' || value === 'Paused' ? value : 'Stopped';
}

/**
 * The player to show: one that is playing wins (the most recently changed if several are),
 * otherwise the most recently changed one with a title. Null if none has a track.
 */
export function activePlayer(players: MediaPlayer[]): MediaPlayer | null {
    const withTrack = players.filter(player => player.title);
    const byRecency = (a: MediaPlayer, b: MediaPlayer) => b.changedAt - a.changedAt;
    return withTrack.filter(p => p.status === 'Playing').sort(byRecency)[0] ??
        withTrack.sort(byRecency)[0] ?? null;
}

/** "Title — Artist", or just the title. */
export function trackLine(player: MediaPlayer): string {
    return player.artist ? `${player.title} — ${player.artist}` : player.title;
}

/** A key that changes when a different track starts, for the "new song" live activity. */
export function trackKey(player: MediaPlayer | null): string {
    return player ? `${player.busName}\n${player.title}\n${player.artist}` : '';
}
