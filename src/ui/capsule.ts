import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const MORPH_MS = 250;
const LIVE_ACTIVITY_MS = 4000;

/**
 * The island in the top bar: a compact text, temporary live activities that grow the capsule,
 * and an "unavailable" look while the daemon is not running.
 */
export class Capsule extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    private readonly pill: St.BoxLayout;
    private readonly label: St.Label;
    private mirror: Clutter.Actor | null = null;
    private liveTimeoutId = 0;
    private compact = 'Claude';

    /** `onSimulate` is a spike hook: the menu item sends a fake agent event through the daemon. */
    constructor(onSimulate: () => void) {
        super(0.5, 'Islet', false);

        this.pill = new St.BoxLayout({
            style_class: 'islet-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.pill.add_child(new St.Widget({
            style_class: 'islet-dot',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this.label = new St.Label({
            style_class: 'islet-label',
            y_align: Clutter.ActorAlign.CENTER,
            text: this.compact,
        });
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.pill.add_child(this.label);
        this.add_child(this.pill);

        if (this.menu instanceof PopupMenu.PopupMenu) {
            const simulate = new PopupMenu.PopupMenuItem(_('Simulate agent event'));
            simulate.connect('activate', onSimulate);
            this.menu.addMenuItem(simulate);
        }

        // Outside a morph, follow width changes from styling, fonts or scaling.
        this.container.connectObject('notify::allocation', () => {
            if (this.container.get_transition('width'))
                return;
            const width = this.container.allocation.get_width();
            if (this.mirror && this.mirror.width !== width)
                this.mirror.set_width(width);
        }, this);
    }

    /** The text shown while no live activity runs. */
    get compactText(): string {
        return this.compact;
    }

    /** The text on screen right now. */
    get shownText(): string {
        return this.label.text;
    }

    get isLive(): boolean {
        return this.liveTimeoutId !== 0;
    }

    get isAvailable(): boolean {
        return !this.pill.has_style_pseudo_class('unavailable');
    }

    setCompactText(text: string): void {
        if (text === this.compact)
            return;
        this.compact = text;
        if (!this.isLive)
            this.morphTo(text);
    }

    setAvailable(available: boolean): void {
        if (available)
            this.pill.remove_style_pseudo_class('unavailable');
        else
            this.pill.add_style_pseudo_class('unavailable');
    }

    /**
     * Keeps `actor` exactly as wide as the capsule, so a spacer on the clock's other side keeps
     * the clock centred while the capsule grows and shrinks.
     */
    setMirror(actor: Clutter.Actor | null): void {
        this.mirror = actor;
    }

    showLiveActivity(text: string): void {
        this.clearLiveTimeout();
        this.pill.add_style_pseudo_class('live');
        this.morphTo(text);

        this.liveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LIVE_ACTIVITY_MS, () => {
            this.liveTimeoutId = 0;
            this.pill.remove_style_pseudo_class('live');
            this.morphTo(this.compact);
            return GLib.SOURCE_REMOVE;
        });
    }

    override destroy(): void {
        this.clearLiveTimeout();
        this.mirror = null;
        super.destroy();
    }

    private targetWidth(): number {
        return this.container.get_preferred_width(-1)[1];
    }

    private morphTo(text: string): void {
        const from = this.container.width;
        this.label.text = text;

        this.container.remove_transition('width');
        this.container.set_width(-1);
        const to = this.targetWidth();

        // Both actors run the same transition, so they have the same width on every frame.
        for (const actor of [this.container, this.mirror]) {
            if (!actor)
                continue;
            actor.remove_transition('width');
            actor.set_width(from);
            actor.ease({
                width: to,
                duration: MORPH_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
    }

    private clearLiveTimeout(): void {
        if (this.liveTimeoutId) {
            GLib.source_remove(this.liveTimeoutId);
            this.liveTimeoutId = 0;
        }
    }
}

/** An invisible, inert panel item that mirrors the capsule's width on the other side of the clock. */
export class CapsuleSpacer extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.5, 'Islet spacer', true);
        this.reactive = false;
        this.can_focus = false;
        this.track_hover = false;
        this.container.opacity = 0;
    }
}
