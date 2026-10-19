// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {barLayout} from '../core/barLayout.js';
import {formatAgo} from '../core/panel.js';
import type {PlanUsage, PlanWindow} from '../core/protocol.js';
import {formatLocal} from '../services/localTime.js';

function label(text: string, styleClass: string): St.Label {
    return new St.Label({text, style_class: styleClass, x_align: Clutter.ActorAlign.START});
}

/**
 * Where and when the plan figures were measured, for the note under the bars; `estimated` adds
 * that the "≈" figure is an estimate.
 */
export function planNote(plan: PlanUsage | null, now: number, estimated = false): string {
    if (!plan)
        return _('Appears once the Claude desktop app or a terminal session reports it.');
    const ago = formatAgo(now - plan.measuredAt, _);
    let note: string;
    switch (plan.source) {
    case 'desktop':
        note = _('Measured %s by the Claude desktop app.').replace('%s', ago);
        break;
    case 'limit':
        note = _('Limit reached %s.').replace('%s', ago);
        break;
    default:
        note = _('Measured %s in a terminal session.').replace('%s', ago);
    }
    return estimated ? `${note} ${_('≈ is estimated from what you used since.')}` : note;
}

const BAR_HEIGHT = 6;
const GREEN = [0.56, 0.82, 0.56] as const;
const ORANGE = [0.96, 0.65, 0.14] as const;
/** From this percentage on the bar turns orange. */
const HIGH_PERCENT = 90;

/**
 * The bar itself, drawn with Cairo from the width it has when it is painted. The fill used to be
 * a child widget sized from the track's width: closing and reopening the panel left it at a
 * stale size (7 px instead of 27 %), and in the light theme the track shrank with it.
 */
class Bar extends St.DrawingArea {
    static {
        GObject.registerClass(this);
    }

    private measured = 0;
    private estimated: number | null = null;
    private lastPainted = {width: 0, measured: 0, estimated: 0};

    constructor() {
        super({style_class: 'islet-bar', x_expand: true, height: BAR_HEIGHT});
    }

    setPercent(measuredPercent: number, estimatedPercent: number | null): void {
        this.measured = measuredPercent;
        this.estimated = estimatedPercent;
        this.queue_repaint();
    }

    /** What the last repaint drew, in pixels, for the end-to-end test (all zero before the first). */
    get painted(): {width: number; measured: number; estimated: number} {
        return this.lastPainted;
    }

    override vfunc_repaint(): void {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        const radius = height / 2;
        const color = this.measured >= HIGH_PERCENT || (this.estimated ?? 0) >= HIGH_PERCENT ? ORANGE : GREEN;
        const {measured, estimated} = barLayout(width, this.measured, this.estimated);
        this.lastPainted = {width, measured, estimated};

        const roundedRect = (x: number, w: number, alpha: number, [r, g, b]: readonly [number, number, number]) => {
            if (w <= 0)
                return;
            const rad = Math.min(radius, w / 2);
            cr.setSourceRGBA(r, g, b, alpha);
            cr.newSubPath();
            cr.arc(x + w - rad, rad, rad, -Math.PI / 2, Math.PI / 2);
            cr.arc(x + rad, rad, rad, Math.PI / 2, 3 * Math.PI / 2);
            cr.closePath();
            cr.fill();
        };

        roundedRect(0, width, 0.25, [0.5, 0.5, 0.5]);
        roundedRect(0, measured, 1, color);
        if (estimated > 0) {
            // The estimate is lighter, and squared where it meets the measured part.
            cr.save();
            cr.rectangle(measured, 0, estimated, height);
            cr.clip();
            roundedRect(0, measured + estimated, 0.45, color);
            cr.restore();
        }
        cr.$dispose();
    }
}

/** A labelled bar for one plan window. */
export class PlanBar extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    private readonly value: St.Label;
    private readonly bar = new Bar();

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
        this.add_child(this.bar);
    }

    /** Geometry of the bar, for the end-to-end test: what is painted, from the width it has. */
    get geometry(): {width: number; measured: number; estimated: number} {
        return this.bar.painted;
    }

    /**
     * Shows a window. `estimatedPercent` is the current estimate, when it is above the measured
     * figure: the label then leads with it ("≈ 31 %") and the bar shows the difference lighter.
     */
    setWindow(window: PlanWindow | undefined, estimatedPercent: number | null = null): void {
        this.visible = Boolean(window);
        if (!window)
            return;
        const measured = Math.round(window.usedPercentage);
        const estimate = estimatedPercent !== null && Math.round(estimatedPercent) > measured ? Math.round(estimatedPercent) : null;
        const shown = estimate === null ? `${measured}%` : `≈ ${estimate}%`;
        this.value.text = window.resetsAt === undefined
            ? shown
            : _('%s · resets %s').replace('%s', shown).replace('%s', formatLocal(window.resetsAt, this.resetFormat));
        this.bar.setPercent(window.usedPercentage, estimate);
    }
}
