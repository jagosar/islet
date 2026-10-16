// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseAgentEvent} from '../core/agentEvents.js';
import {INTERFACE_XML, MAX_METHOD_FIELDS, OBJECT_PATH} from '../core/dbus.js';
import {RateLimiter, planUpdateActions} from '../core/limits.js';
import {
    decodePlanUsage, encodePlanUsage, encodeSessions, encodeUsage, parsePlanUsageReport,
    type AgentSession, type PlanUsage, type UsageSnapshot,
} from '../core/protocol.js';
import type {StateStore} from './stateStore.js';

const PLAN_USAGE_FILE = 'plan-usage.json';

function nowSeconds(): number {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

function monotonicSeconds(): number {
    return GLib.get_monotonic_time() / 1_000_000;
}

/**
 * The exported io.github.jagosar.Islet1 object. The daemon's modules update it through the
 * set* methods; each change is announced with PropertiesChanged.
 *
 * Method and property names are PascalCase because wrapJSObject maps them to D-Bus by name.
 */
export class IsletService {
    private exported: Gio.DBusExportedObject | null = null;
    private usage: UsageSnapshot = {today: null, history: []};
    private plan: PlanUsage | null;
    private sessions: AgentSession[] = [];
    /** Anything on the session bus can call the daemon: bursts are allowed, floods are dropped. */
    private readonly eventLimiter = new RateLimiter(50, 100);
    private readonly planLimiter = new RateLimiter(20, 40);
    private lastWarning = Number.NEGATIVE_INFINITY;
    private lastPlan = {published: 0, persisted: 0};
    private agentEventListener: ((fields: Record<string, string>, at: number) => void) | null = null;

    constructor(private readonly store: StateStore) {
        this.plan = decodePlanUsage(store.read(PLAN_USAGE_FILE) ?? '');
    }

    export(connection: Gio.DBusConnection): void {
        this.exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this.exported.export(connection, OBJECT_PATH);
    }

    /** Called for every valid agent event with its time (after the signal went out, if there is one). */
    onAgentEvent(listener: (fields: Record<string, string>, at: number) => void): void {
        this.agentEventListener = listener;
    }

    // D-Bus properties.

    get Usage(): string {
        return encodeUsage(this.usage);
    }

    get PlanUsage(): string {
        return encodePlanUsage(this.plan);
    }

    get Sessions(): string {
        return encodeSessions(this.sessions);
    }

    // D-Bus methods.

    ReportAgentEvent(fields: Record<string, string>): void {
        if (!this.eventLimiter.take(monotonicSeconds())) {
            this.warnOncePerInterval('too many agent events; dropping them');
            return;
        }
        if (!parseAgentEvent(fields)) {
            console.warn('islet-daemon: ignored an invalid agent event');
            return;
        }
        this.exported?.emit_signal('AgentEvent', new GLib.Variant('(a{ss})', [fields]));
        this.agentEventListener?.(fields, nowSeconds());
    }

    /** An event a bridge left in the spool while the daemon was not running: state only, no signal. */
    replayAgentEvent(fields: Record<string, string>, at: number): void {
        if (parseAgentEvent(fields))
            this.agentEventListener?.(fields, at);
    }

    /** Plan usage from the spool, applied only if it is newer than what the daemon knows. */
    replayPlanUsage(fields: Record<string, number>, at: number): void {
        const plan = parsePlanUsageReport(fields, at);
        if (plan && (!this.plan || plan.measuredAt >= this.plan.measuredAt))
            this.updatePlan(plan);
    }

    ReportPlanUsage(fields: Record<string, number>): void {
        if (!this.planLimiter.take(monotonicSeconds())) {
            this.warnOncePerInterval('too many plan usage reports; dropping them');
            return;
        }
        const plan = Object.keys(fields).length <= MAX_METHOD_FIELDS ? parsePlanUsageReport(fields, nowSeconds()) : null;
        if (!plan) {
            console.warn('islet-daemon: ignored an invalid plan usage report');
            return;
        }
        this.updatePlan(plan);
    }

    /** The latest report is always kept; clients and the disk hear of it when it matters (see planUpdateActions). */
    private updatePlan(plan: PlanUsage): void {
        const now = nowSeconds();
        const {publish, persist} = planUpdateActions(this.plan, plan, this.lastPlan, now);
        this.plan = plan;
        if (persist) {
            this.store.write(PLAN_USAGE_FILE, encodePlanUsage(plan));
            this.lastPlan.persisted = now;
        }
        if (publish) {
            this.changed('PlanUsage', this.PlanUsage);
            this.lastPlan.published = now;
        }
    }

    private warnOncePerInterval(message: string): void {
        const now = monotonicSeconds();
        if (now - this.lastWarning < 5)
            return;
        this.lastWarning = now;
        console.warn(`islet-daemon: ${message}`);
    }

    // For the daemon's modules.

    setUsage(usage: UsageSnapshot): void {
        this.usage = usage;
        this.changed('Usage', this.Usage);
    }

    setSessions(sessions: AgentSession[]): void {
        this.sessions = sessions;
        this.changed('Sessions', this.Sessions);
    }

    private changed(property: string, value: string): void {
        this.exported?.emit_property_changed(property, new GLib.Variant('s', value));
    }
}
