// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {parseAgentEvent} from '../core/agentEvents.js';
import {SessionTracker} from '../core/sessions.js';
import type {IsletService} from './service.js';

function nowSeconds(): number {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

/** Keeps the Sessions property current from agent events, with one timer for expiry. */
export class SessionsModule {
    private readonly tracker = new SessionTracker();
    private expiryId = 0;

    constructor(private readonly service: IsletService) {
        service.onAgentEvent(fields => {
            const event = parseAgentEvent(fields);
            if (event && this.tracker.apply(event, nowSeconds()))
                this.publish();
        });
    }

    private publish(): void {
        this.service.setSessions(this.tracker.list());
        this.scheduleExpiry();
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
