// SPDX-License-Identifier: GPL-2.0-or-later

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import type {CompactView, Tone} from '../core/island.js';

const MORPH_MS = 250;
const TONES: Tone[] = ['normal', 'attention', 'muted'];

/**
 * The island in the top bar. It shows either the compact view or a live activity; which one,
 * and for how long, is decided by the extension (core/island.ts). Its menu is the expanded view.
 */
export class Capsule extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    private readonly pill: St.BoxLayout;
    private readonly label: St.Label;
    private mirror: Clutter.Actor | null = null;
    private compact: CompactView = {text: 'Claude', tone: 'muted'};
    private live: CompactView | null = null;

    constructor() {
        super(0.5, 'Islet', false);
        this.accessible_name = 'Islet';

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
            text: this.compact.text,
        });
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.pill.add_child(this.label);
        this.add_child(this.pill);
        this.label_actor = this.label;
        this.applyTone(this.compact.tone);

        // Outside a morph, follow width changes from styling, fonts or scaling.
        this.container.connectObject('notify::allocation', () => {
            if (this.container.get_transition('width'))
                return;
            const width = this.container.allocation.get_width();
            if (this.mirror && this.mirror.width !== width)
                this.mirror.set_width(width);
        }, this);
    }

    get shownText(): string {
        return this.label.text;
    }

    /** Width of the clock-centring spacer, for the development debug service. */
    get mirrorWidth(): number | null {
        return this.mirror ? Math.round(this.mirror.width) : null;
    }

    get compactText(): string {
        return this.compact.text;
    }

    get isLive(): boolean {
        return this.live !== null;
    }

    get isAvailable(): boolean {
        return !this.pill.has_style_pseudo_class('muted');
    }

    setCompact(view: CompactView): void {
        if (view.text === this.compact.text && view.tone === this.compact.tone)
            return;
        this.compact = view;
        if (!this.live)
            this.display(view);
    }

    /** Shows a live activity until it is replaced or cleared with null. */
    setLive(view: CompactView | null): void {
        this.live = view;
        if (view)
            this.pill.add_style_pseudo_class('live');
        else
            this.pill.remove_style_pseudo_class('live');
        this.display(view ?? this.compact);
    }

    /**
     * Keeps `actor` exactly as wide as the capsule, so a spacer on the clock's other side keeps
     * the clock centred while the capsule grows and shrinks.
     */
    setMirror(actor: Clutter.Actor | null): void {
        this.mirror = actor;
    }

    override destroy(): void {
        this.mirror = null;
        super.destroy();
    }

    private display(view: CompactView): void {
        this.applyTone(view.tone);
        if (view.text !== this.label.text)
            this.morphTo(view.text);
    }

    private applyTone(tone: Tone): void {
        for (const other of TONES) {
            if (other === tone)
                this.pill.add_style_pseudo_class(other);
            else
                this.pill.remove_style_pseudo_class(other);
        }
    }

    private morphTo(text: string): void {
        const from = this.container.width;
        this.label.text = text;

        this.container.remove_transition('width');
        this.container.set_width(-1);
        const to = this.container.get_preferred_width(-1)[1];

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
        this.accessible_role = Atk.Role.INVALID; // Invisible to screen readers.
    }
}
