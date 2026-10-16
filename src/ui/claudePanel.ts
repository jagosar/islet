// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {todayFreshTokens} from '../core/compact.js';
import {formatTokens} from '../core/format.js';
import {HEATMAP_WEEKS, formatAgo, formatDuration, heatmapCells, sessionStateLabel, type HeatmapCell} from '../core/panel.js';
import type {PlanWindow} from '../core/protocol.js';
import {freshTokens, processedTokens, type TokenCounts} from '../core/usage/claudeTranscript.js';
import type {DaemonState} from '../services/daemonClient.js';

const CELL = 9;
const GAP = 2;
/** Opacity of the theme's foreground colour for each heatmap level. */
const LEVEL_ALPHA = [0.08, 0.3, 0.5, 0.72, 0.95];

function label(text: string, styleClass: string): St.Label {
    return new St.Label({text, style_class: styleClass, x_align: Clutter.ActorAlign.START});
}

function sumTokens(models: Record<string, TokenCounts>): TokenCounts {
    const total: TokenCounts = {input: 0, cacheWrite: 0, cacheRead: 0, output: 0};
    for (const tokens of Object.values(models)) {
        total.input += tokens.input;
        total.cacheWrite += tokens.cacheWrite;
        total.cacheRead += tokens.cacheRead;
        total.output += tokens.output;
    }
    return total;
}

function formatClock(epochSeconds: number): string {
    return GLib.DateTime.new_from_unix_local(epochSeconds)?.format('%H:%M') ?? '';
}

/** The 26-week usage graph, drawn in one actor with Cairo in the theme's text colour. */
class Heatmap extends St.DrawingArea {
    static {
        GObject.registerClass(this);
    }

    private cells: HeatmapCell[][] = [];

    constructor() {
        super({
            style_class: 'islet-heatmap',
            width: HEATMAP_WEEKS * (CELL + GAP) - GAP,
            height: 7 * (CELL + GAP) - GAP,
        });
        this.accessible_name = _('Usage over the last 26 weeks');
    }

    setCells(cells: HeatmapCell[][]): void {
        this.cells = cells;
        this.queue_repaint();
    }

    override vfunc_repaint(): void {
        const cr = this.get_context();
        const color = this.get_theme_node().get_foreground_color();
        this.cells.forEach((column, x) => column.forEach((cell, y) => {
            if (!cell.inRange)
                return;
            cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, LEVEL_ALPHA[cell.level]);
            cr.rectangle(x * (CELL + GAP), y * (CELL + GAP), CELL, CELL);
            cr.fill();
        }));
        cr.$dispose();
    }
}

/** A labelled bar for one plan window. */
class PlanBar extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    private readonly value: St.Label;
    private readonly fill: St.Widget;
    private readonly track: St.Widget;
    private fraction = 0;

    constructor(title: string) {
        super({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-plan-bar', x_expand: true});
        const header = new St.BoxLayout({x_expand: true});
        header.add_child(label(title, 'islet-caption'));
        this.value = label('', 'islet-caption islet-plan-value');
        this.value.x_expand = true;
        this.value.x_align = Clutter.ActorAlign.END;
        header.add_child(this.value);
        this.add_child(header);

        this.track = new St.Widget({style_class: 'islet-bar-track', x_expand: true});
        this.fill = new St.Widget({style_class: 'islet-bar-fill'});
        this.track.add_child(this.fill);
        this.add_child(this.track);
        // The fill is a share of the track, whose width is known only once allocated.
        this.track.connect('notify::width', () => this.layoutFill());
    }

    private layoutFill(): void {
        this.fill.set_width(Math.round(this.track.width * this.fraction));
    }

    setWindow(window: PlanWindow | undefined): void {
        this.visible = Boolean(window);
        if (!window)
            return;
        const percent = Math.round(window.usedPercentage);
        this.value.text = _('%s · resets %s').replace('%s', `${percent}%`).replace('%s', formatClock(window.resetsAt));
        this.fraction = Math.min(100, window.usedPercentage) / 100;
        this.layoutFill();
        this.fill.set_style_class_name(percent >= 90 ? 'islet-bar-fill islet-bar-high' : 'islet-bar-fill');
    }
}

/** The Claude Code view of the expanded island. */
export class ClaudePanel extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    private readonly todayValue = label('—', 'islet-big-number');
    private readonly todayDetail = label('', 'islet-caption');
    private readonly todayProcessed = label('', 'islet-caption');
    private readonly fiveHour = new PlanBar(_('5-hour limit'));
    private readonly weekly = new PlanBar(_('Weekly limit'));
    private readonly planNote = label('', 'islet-note');
    private readonly sessionsBox = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-sessions'});
    private readonly heatmap = new Heatmap();
    private state: DaemonState | null = null;

    constructor() {
        super({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-panel', x_expand: true});

        this.add_child(label(_('Today'), 'islet-section-title'));
        const today = new St.BoxLayout({style_class: 'islet-today'});
        today.add_child(this.todayValue);
        today.add_child(label(_('fresh tokens'), 'islet-caption islet-unit'));
        this.add_child(today);
        this.add_child(this.todayDetail);
        this.add_child(this.todayProcessed);

        this.add_child(label(_('Plan usage'), 'islet-section-title'));
        this.add_child(this.fiveHour);
        this.add_child(this.weekly);
        this.add_child(this.planNote);

        this.add_child(label(_('Sessions'), 'islet-section-title'));
        this.add_child(this.sessionsBox);

        this.add_child(label(_('Last 26 weeks'), 'islet-section-title'));
        this.add_child(this.heatmap);

        this.add_child(label(_('Figures of running sessions are approximate until they end.'), 'islet-note'));

        // Bar widths depend on the track width, known only after allocation.
        this.connect('notify::mapped', () => this.mapped && this.refresh());
    }

    update(state: DaemonState): void {
        this.state = state;
        this.refresh();
    }

    /** Re-renders, including the relative times ("5 min ago"). */
    refresh(): void {
        const state = this.state;
        if (!state)
            return;
        const now = Math.floor(GLib.get_real_time() / 1_000_000);

        if (!state.available) {
            this.todayValue.text = '—';
            this.todayDetail.text = _('Islet is starting or not running.');
            this.todayProcessed.text = '';
        } else {
            const models = state.usage?.today?.models ?? {};
            const total = sumTokens(models);
            this.todayValue.text = formatTokens(todayFreshTokens(state.usage));
            const used = freshTokens(total) > 0;
            this.todayDetail.text = used
                ? _('input %s · cache write %s · output %s')
                    .replace('%s', formatTokens(total.input))
                    .replace('%s', formatTokens(total.cacheWrite))
                    .replace('%s', formatTokens(total.output))
                : _('No Claude Code usage yet today.');
            this.todayProcessed.text = used
                ? _('%s processed, including cache reads').replace('%s', formatTokens(processedTokens(total)))
                : '';
        }

        const plan = state.plan;
        this.fiveHour.setWindow(plan?.fiveHour);
        this.weekly.setWindow(plan?.sevenDay);
        this.planNote.text = plan
            ? _('Measured %s in a terminal session.').replace('%s', formatAgo(now - plan.measuredAt, _))
            : _('Appears after Claude replies in a terminal session (the desktop app and VS Code do not report it).');

        this.sessionsBox.destroy_all_children();
        if (!state.sessions.length)
            this.sessionsBox.add_child(label(_('No active sessions.'), 'islet-note'));
        for (const session of state.sessions) {
            const row = new St.BoxLayout({style_class: 'islet-session-row', x_expand: true});
            row.add_child(new St.Widget({style_class: `islet-state-dot islet-state-${session.state}`, y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(label(session.project, 'islet-session-project'));
            const detail = label(`${sessionStateLabel(session.state, _)} · ${formatDuration(now - session.since, _)}`, 'islet-caption');
            detail.x_expand = true;
            detail.x_align = Clutter.ActorAlign.END;
            row.add_child(detail);
            this.sessionsBox.add_child(row);
        }

        const today = GLib.DateTime.new_now_local().format('%Y-%m-%d') ?? '';
        this.heatmap.setCells(heatmapCells(state.usage, today));
    }
}
