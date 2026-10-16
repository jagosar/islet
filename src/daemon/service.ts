// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseAgentEvent} from '../core/agentEvents.js';
import {INTERFACE_XML, MAX_METHOD_FIELDS, OBJECT_PATH} from '../core/dbus.js';
import {
    decodePlanUsage, encodePlanUsage, encodeSessions, encodeUsage, parsePlanUsageReport,
    type AgentSession, type PlanUsage, type UsageSnapshot,
} from '../core/protocol.js';
import type {StateStore} from './stateStore.js';

const PLAN_USAGE_FILE = 'plan-usage.json';

function nowSeconds(): number {
    return Math.floor(GLib.get_real_time() / 1_000_000);
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
    private agentEventListener: ((fields: Record<string, string>) => void) | null = null;

    constructor(private readonly store: StateStore) {
        this.plan = decodePlanUsage(store.read(PLAN_USAGE_FILE) ?? '');
    }

    export(connection: Gio.DBusConnection): void {
        this.exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
        this.exported.export(connection, OBJECT_PATH);
    }

    /** Called for every valid agent event, after the signal went out. */
    onAgentEvent(listener: (fields: Record<string, string>) => void): void {
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
        if (!parseAgentEvent(fields)) {
            console.warn('islet-daemon: ignored an invalid agent event');
            return;
        }
        this.exported?.emit_signal('AgentEvent', new GLib.Variant('(a{ss})', [fields]));
        this.agentEventListener?.(fields);
    }

    ReportPlanUsage(fields: Record<string, number>): void {
        const plan = Object.keys(fields).length <= MAX_METHOD_FIELDS ? parsePlanUsageReport(fields, nowSeconds()) : null;
        if (!plan) {
            console.warn('islet-daemon: ignored an invalid plan usage report');
            return;
        }
        this.plan = plan;
        this.store.write(PLAN_USAGE_FILE, encodePlanUsage(plan));
        this.changed('PlanUsage', this.PlanUsage);
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
