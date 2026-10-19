// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatDuration, sessionStateLabel} from '../core/panel.js';
import type {InsightsWindow, SessionSummary} from '../core/usage/insights.js';
import {
    attributionKindLabel, attributionName, breakdownTable, flagLabel, formatShare, formatUsd, modelMix,
} from '../core/usageView.js';
import type {DaemonState} from '../services/daemonClient.js';
import {PlanBar, planNote} from './planBar.js';

function label(text: string, styleClass: string): St.Label {
    return new St.Label({text, style_class: styleClass, x_align: Clutter.ActorAlign.START});
}

/** A caption or note that wraps onto more lines instead of being cut off at the panel's width. */
function note(text: string): St.Label {
    const wrapped = label(text, 'islet-note');
    wrapped.x_expand = true;
    wrapped.clutter_text.line_wrap = true;
    wrapped.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return wrapped;
}

/** "Cost  $86.50" style row: a caption on the left, its value on the right. */
function pair(caption: string, value: string): St.BoxLayout {
    const row = new St.BoxLayout({style_class: 'islet-pair', x_expand: true});
    row.add_child(label(caption, 'islet-caption islet-pair-caption'));
    const valueLabel = label(value, 'islet-caption islet-pair-value');
    valueLabel.x_expand = true;
    valueLabel.x_align = Clutter.ActorAlign.END;
    row.add_child(valueLabel);
    return row;
}

/** A share row: label, a thin bar and the percentage. */
function shareRow(text: string, detail: string, share: number): St.BoxLayout {
    const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-share-row', x_expand: true});
    const header = new St.BoxLayout({x_expand: true});
    const name = label(text, 'islet-caption islet-share-name');
    name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    header.add_child(name);
    if (detail)
        header.add_child(label(detail, 'islet-note islet-share-kind'));
    const value = label(formatShare(share), 'islet-caption islet-pair-value');
    value.x_expand = true;
    value.x_align = Clutter.ActorAlign.END;
    header.add_child(value);
    box.add_child(header);

    const track = new St.Widget({style_class: 'islet-share-track', x_expand: true});
    const fill = new St.Widget({style_class: 'islet-share-fill'});
    track.add_child(fill);
    track.connect('notify::width', () => fill.set_width(Math.round(track.width * Math.min(1, share))));
    box.add_child(track);
    return box;
}

/**
 * The Claude view of the expanded island: plan limits, who is waiting for you, the current
 * session and what is using the limits, like the Claude desktop app's usage panel, from what
 * Claude Code records on this computer.
 */
export class ClaudePanel extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    private readonly fiveHour = new PlanBar(_('Session limit (5 hours)'));
    private readonly weekly = new PlanBar(_('Weekly limit'), '%a %H:%M');
    private readonly planNote = note('');
    private readonly agentsTitle = label(_('Sessions'), 'islet-section-title');
    private readonly agentsBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-sessions'});
    private readonly sessionTitle = label(_('This session'), 'islet-section-title');
    private readonly sessionBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-usage-session'});
    private readonly dayButton: St.Button;
    private readonly weekButton: St.Button;
    private readonly limitsBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-usage-limits'});
    private range: 'day' | 'week' = 'day';
    private state: DaemonState | null = null;

    constructor() {
        super({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-panel', x_expand: true});

        this.add_child(label(_('Plan usage'), 'islet-section-title'));
        this.add_child(this.fiveHour);
        this.add_child(this.weekly);
        this.add_child(this.planNote);

        this.add_child(this.agentsTitle);
        this.add_child(this.agentsBox);

        this.add_child(this.sessionTitle);
        this.add_child(this.sessionBox);

        const header = new St.BoxLayout({x_expand: true});
        const title = label(_('What is using your limits'), 'islet-section-title');
        title.x_expand = true;
        header.add_child(title);
        this.dayButton = this.rangeButton(_('24 h'), 'day');
        this.weekButton = this.rangeButton(_('7 days'), 'week');
        header.add_child(this.dayButton);
        header.add_child(this.weekButton);
        this.add_child(header);
        this.add_child(this.limitsBox);
        this.add_child(note(_('Approximate and overlapping; this computer only, not claude.ai.')));

        this.connect('notify::mapped', () => this.mapped && this.refresh());
    }

    private rangeButton(text: string, range: 'day' | 'week'): St.Button {
        const button = new St.Button({label: text, style_class: 'islet-range', can_focus: true, y_align: Clutter.ActorAlign.END});
        button.connect('clicked', () => {
            this.range = range;
            this.refresh();
        });
        return button;
    }

    update(state: DaemonState): void {
        this.state = state;
        this.refresh();
    }

    refresh(): void {
        const state = this.state;
        if (!state)
            return;
        const now = Math.floor(GLib.get_real_time() / 1_000_000);

        this.fiveHour.setWindow(state.plan?.fiveHour);
        this.weekly.setWindow(state.plan?.sevenDay);
        this.planNote.text = state.available ? planNote(state.plan, now) : _('Islet is starting or not running.');

        this.renderAgents(state, now);

        this.dayButton.checked = this.range === 'day';
        this.weekButton.checked = this.range === 'week';

        this.renderSession(state.insights?.session ?? null);
        const window = state.insights ? state.insights[this.range] : null;
        this.renderLimits(window);
    }

    /** Who is working or waiting for you; the whole section is hidden when nothing runs. */
    private renderAgents(state: DaemonState, now: number): void {
        this.agentsBox.destroy_all_children();
        const sessions = state.available ? state.sessions : [];
        this.agentsTitle.visible = sessions.length > 0;
        this.agentsBox.visible = sessions.length > 0;
        for (const session of sessions) {
            const row = new St.BoxLayout({style_class: 'islet-session-row', x_expand: true});
            row.add_child(new St.Widget({style_class: `islet-state-dot islet-state-${session.state}`, y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(label(session.project, 'islet-session-project'));
            const detail = label(`${sessionStateLabel(session.state, _)} · ${formatDuration(now - session.since, _)}`, 'islet-caption');
            detail.x_expand = true;
            detail.x_align = Clutter.ActorAlign.END;
            row.add_child(detail);
            this.agentsBox.add_child(row);
        }
    }

    private renderSession(session: SessionSummary | null): void {
        this.sessionBox.destroy_all_children();
        this.sessionTitle.text = session?.project ? _('This session · %s').replace('%s', session.project) : _('This session');
        if (!session) {
            this.sessionBox.add_child(note(_('No Claude Code session in the last 7 days.')));
            return;
        }

        const cost = session.exact ? formatUsd(session.usd) : `≈ ${formatUsd(session.usd)}`;
        this.sessionBox.add_child(pair(_('Cost'), cost));
        this.sessionBox.add_child(pair(_('Active'), formatDuration(session.activeSeconds, _)));
        if (session.apiSeconds !== undefined)
            this.sessionBox.add_child(pair(_('API'), formatDuration(session.apiSeconds, _)));
        if (session.linesAdded !== undefined || session.linesRemoved !== undefined)
            this.sessionBox.add_child(pair(_('Lines'), `+${session.linesAdded ?? 0} −${session.linesRemoved ?? 0}`));
        this.sessionBox.add_child(pair(_('Models'), modelMix(session)));
        this.sessionBox.add_child(pair(_('Cache hits'), formatShare(session.cacheHitRatio)));

        const table = breakdownTable(session, _);
        const grid = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-breakdown'});
        const headerRow = new St.BoxLayout({style_class: 'islet-breakdown-row'});
        headerRow.add_child(label(_('Breakdown'), 'islet-caption islet-breakdown-label islet-breakdown-head'));
        for (const column of table.columns)
            headerRow.add_child(label(column, 'islet-caption islet-breakdown-cell islet-breakdown-head'));
        grid.add_child(headerRow);
        for (const row of table.rows) {
            const line = new St.BoxLayout({style_class: 'islet-breakdown-row'});
            line.add_child(label(row.label, 'islet-caption islet-breakdown-label'));
            for (const cell of row.cells)
                line.add_child(label(cell, 'islet-caption islet-breakdown-cell'));
            grid.add_child(line);
        }
        this.sessionBox.add_child(grid);
        if (!session.exact)
            this.sessionBox.add_child(note(_('Estimated at list prices until the session ends.')));
    }

    private renderLimits(window: InsightsWindow | null): void {
        this.limitsBox.destroy_all_children();
        if (!window || window.requests === 0) {
            this.limitsBox.add_child(note(_('No Claude Code usage in this period.')));
            return;
        }
        for (const flag of window.flags)
            this.limitsBox.add_child(shareRow(flagLabel(flag.id, _), '', flag.share));
        for (const row of window.attribution)
            this.limitsBox.add_child(shareRow(attributionName(row.kind, row.name), attributionKindLabel(row.kind, _), row.share));
        if (!window.flags.length && !window.attribution.length)
            this.limitsBox.add_child(note(_('Nothing stands out: no behaviour, skill, subagent or MCP server reaches 1%.')));
    }
}
