// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';

import {estimateFiveHour, type PlanSample, type WeightBetween} from '../core/planEstimate.js';
import type {IsletService} from './service.js';

/** How often the estimate is recomputed: once a minute, as the capsule's figure should move. */
export const ESTIMATE_INTERVAL_S = 60;

/**
 * Keeps the PlanEstimate property current: once a minute, and whenever the desktop app's history
 * is read, it extends the latest measured 5-hour figure with what the transcripts say was used
 * since (see core/planEstimate.ts). The work is two binary searches over running totals and a loop
 * over the history's recent samples, so it costs microseconds; nothing is sent unless the whole
 * percentage changes.
 */
export class PlanEstimateModule {
    private timerId = 0;

    constructor(
        private readonly service: IsletService,
        private readonly samples: () => readonly PlanSample[],
        private readonly weightBetween: WeightBetween,
        private readonly clock: () => number = () => Math.floor(GLib.get_real_time() / 1_000_000),
    ) {}

    start(): void {
        this.refresh();
        this.timerId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, ESTIMATE_INTERVAL_S, () => {
            this.refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    refresh(): void {
        this.service.setPlanEstimate(estimateFiveHour(this.service.currentPlan, this.samples(), this.clock(), this.weightBetween));
    }
}
