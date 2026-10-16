// SPDX-License-Identifier: GPL-2.0-or-later
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {FOCUS_PRESETS_MIN, formatCountdown, remainingSeconds, type FocusState} from '../core/focus.js';
import {formatDuration} from '../core/panel.js';
import {keptDays} from '../services/focusController.js';

export interface FocusActions {
    start(minutes: number): void;
    pause(): void;
    resume(): void;
    stop(): void;
}

function button(text: string, onClick: () => void): St.Button {
    const b = new St.Button({label: text, style_class: 'islet-button', can_focus: true, x_expand: true});
    b.connect('clicked', onClick);
    return b;
}

/** The focus timer: presets, or the countdown with pause/resume and stop; and its history. */
export class FocusPanel extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    private readonly countdown = new St.Label({style_class: 'islet-big-number islet-countdown', x_align: Clutter.ActorAlign.CENTER});
    private readonly presets = new St.BoxLayout({style_class: 'islet-buttons', x_expand: true});
    private readonly running = new St.BoxLayout({style_class: 'islet-buttons', x_expand: true});
    private readonly pauseResume: St.Button;
    private readonly today = new St.Label({style_class: 'islet-caption'});
    private readonly week = new St.Label({style_class: 'islet-caption'});
    private state: FocusState | null = null;

    constructor(actions: FocusActions) {
        super({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-panel', x_expand: true});

        this.add_child(new St.Label({text: _('Focus'), style_class: 'islet-section-title'}));
        this.add_child(this.countdown);
        for (const minutes of FOCUS_PRESETS_MIN)
            this.presets.add_child(button(_('%d min').replace('%d', String(minutes)), () => actions.start(minutes)));
        this.add_child(this.presets);

        this.pauseResume = button(_('Pause'), () => this.state?.timer.status === 'paused' ? actions.resume() : actions.pause());
        this.running.add_child(this.pauseResume);
        this.running.add_child(button(_('Stop'), () => actions.stop()));
        this.add_child(this.running);

        this.add_child(new St.Label({text: _('History'), style_class: 'islet-section-title'}));
        this.add_child(this.today);
        this.add_child(this.week);
    }

    update(state: FocusState): void {
        this.state = state;
        const now = Math.floor(GLib.get_real_time() / 1_000_000);
        const {timer} = state;
        const active = timer.status !== 'idle';

        this.countdown.visible = active;
        this.presets.visible = !active;
        this.running.visible = active;
        if (active) {
            this.countdown.text = formatCountdown(remainingSeconds(timer, now));
            this.pauseResume.label = timer.status === 'paused' ? _('Resume') : _('Pause');
        }

        const [todayKey] = keptDays(now);
        const today = state.history[todayKey] ?? {minutes: 0, sessions: 0};
        const weekMinutes = Object.values(state.history).reduce((sum, day) => sum + day.minutes, 0);
        this.today.text = _('Today: %s · %d sessions')
            .replace('%s', formatDuration(today.minutes * 60, _))
            .replace('%d', String(today.sessions));
        this.week.text = _('Last 7 days: %s').replace('%s', formatDuration(weekMinutes * 60, _));
    }
}
