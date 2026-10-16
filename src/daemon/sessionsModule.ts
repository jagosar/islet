// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {parseAgentEvent} from '../core/agentEvents.js';
import {SessionTracker, decodeSessionSnapshot, encodeSessionSnapshot} from '../core/sessions.js';
import type {IsletService} from './service.js';
import type {StateStore} from './stateStore.js';

const SESSIONS_FILE = 'sessions.json';

function nowSeconds(): number {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

/**
 * Keeps the Sessions property current from agent events, with one timer for expiry. The sessions
 * are saved, so a daemon restart (the extension is switched off while the screen is locked) does
 * not forget them.
 */
export class SessionsModule {
    private readonly tracker = new SessionTracker();
    private expiryId = 0;

    constructor(private readonly service: IsletService, private readonly store: StateStore) {
        this.tracker.restore(decodeSessionSnapshot(store.read(SESSIONS_FILE) ?? ''), nowSeconds());
        if (this.tracker.list().length > 0) {
            service.setSessions(this.tracker.list());
            this.scheduleExpiry();
        }

        service.onAgentEvent((fields, at) => {
            const event = parseAgentEvent(fields);
            if (event && this.tracker.apply(event, at))
                this.publish();
        });
    }

    private publish(): void {
        this.service.setSessions(this.tracker.list());
        this.scheduleExpiry();
        // Saved at once: events are a few per prompt, the file is small, and the daemon can be
        // stopped at any moment (the extension is switched off while the screen is locked).
        this.store.write(SESSIONS_FILE, encodeSessionSnapshot(this.tracker.snapshot()));
    }

    private scheduleExpiry(): void {
        if (this.expiryId)
            GLib.source_remove(this.expiryId);
        this.expiryId = 0;

        const seconds = this.tracker.secondsUntilNextExpiry(nowSeconds());
        if (seconds === null)
            return;
        this.expiryId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, Math.max(1, seconds), () => {
            this.expiryId = 0;
            if (this.tracker.expire(nowSeconds()))
                this.publish();
            else
                this.scheduleExpiry();
            return GLib.SOURCE_REMOVE;
        });
    }
}
