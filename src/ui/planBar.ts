// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {formatAgo} from '../core/panel.js';
import type {PlanUsage, PlanWindow} from '../core/protocol.js';
import {formatLocal} from '../services/localTime.js';

function label(text: string, styleClass: string): St.Label {
    return new St.Label({text, style_class: styleClass, x_align: Clutter.ActorAlign.START});
}

/** Where and when the plan figures were measured, for the note under the bars. */
export function planNote(plan: PlanUsage | null, now: number): string {
    if (!plan)
        return _('Appears once the Claude desktop app or a terminal session reports it.');
    const ago = formatAgo(now - plan.measuredAt, _);
    switch (plan.source) {
    case 'desktop':
        return _('Measured %s by the Claude desktop app.').replace('%s', ago);
    case 'limit':
        return _('Limit reached %s.').replace('%s', ago);
    default:
        return _('Measured %s in a terminal session.').replace('%s', ago);
    }
}

/** A labelled bar for one plan window. */
export class PlanBar extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    private readonly value: St.Label;
    private readonly fill: St.Widget;
    private readonly track: St.Widget;
    private fraction = 0;

    /** `resetFormat` is a GLib.DateTime format: a time for the 5-hour window, a day and time for the week. */
    constructor(title: string, private readonly resetFormat = '%H:%M') {
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
        this.value.text = window.resetsAt === undefined
            ? `${percent}%`
            : _('%s · resets %s').replace('%s', `${percent}%`).replace('%s', formatLocal(window.resetsAt, this.resetFormat));
        this.fraction = Math.min(100, window.usedPercentage) / 100;
        this.layoutFill();
        this.fill.set_style_class_name(percent >= 90 ? 'islet-bar-fill islet-bar-high' : 'islet-bar-fill');
    }
}
