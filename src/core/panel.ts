// SPDX-License-Identifier: GPL-2.0-or-later

/** Formatting for the expanded view, kept pure so it is unit tested. */
import type {SessionState} from './protocol.js';

type Translate = (text: string) => string;
const identity: Translate = text => text;

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(seconds: number, t: Translate = identity): string {
    if (seconds < 60)
        return t('just now');
    if (seconds < 3600)
        return t('%d min ago').replace('%d', String(Math.floor(seconds / 60)));
    if (seconds < 86400)
        return t('%d h ago').replace('%d', String(Math.floor(seconds / 3600)));
    const days = Math.floor(seconds / 86400);
    return (days === 1 ? t('1 day ago') : t('%d days ago')).replace('%d', String(days));
}

/** "5 min", "3 h 20 min", for how long a session has been in its state. */
export function formatDuration(seconds: number, t: Translate = identity): string {
    const minutes = Math.floor(seconds / 60);
    if (minutes < 1)
        return t('<1 min');
    if (minutes < 60)
        return t('%d min').replace('%d', String(minutes));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? t('%d h %d min').replace('%d', String(hours)).replace('%d', String(rest)) : t('%d h').replace('%d', String(hours));
}

export function sessionStateLabel(state: SessionState, t: Translate = identity): string {
    switch (state) {
    case 'needs-permission':
        return t('needs permission');
    case 'waiting':
        return t('waiting for you');
    case 'working':
        return t('working');
    case 'finished':
        return t('finished');
    case 'idle':
        return t('idle');
    }
}
