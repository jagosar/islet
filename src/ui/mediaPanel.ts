// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import type {MediaPlayer} from '../core/media.js';

export interface MediaActions {
    playPause(busName: string): void;
    next(busName: string): void;
    previous(busName: string): void;
}

function controlButton(iconName: string, accessibleName: string, onClick: () => void): St.Button {
    const button = new St.Button({
        style_class: 'islet-control',
        can_focus: true,
        child: new St.Icon({icon_name: iconName, icon_size: 18}),
        accessible_name: accessibleName,
    });
    button.connect('clicked', onClick);
    return button;
}

/** Now playing: artwork, title, artist and playback controls. */
export class MediaPanel extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    private readonly art = new St.Icon({style_class: 'islet-art', icon_size: 64});
    private readonly title = new St.Label({style_class: 'islet-track-title'});
    private readonly artist = new St.Label({style_class: 'islet-caption'});
    private readonly empty = new St.Label({style_class: 'islet-note', text: _('Nothing is playing.')});
    private readonly track = new St.BoxLayout({style_class: 'islet-track', x_expand: true});
    private readonly controls = new St.BoxLayout({style_class: 'islet-controls', x_align: Clutter.ActorAlign.CENTER});
    private readonly previous: St.Button;
    private readonly playPause: St.Button;
    private readonly next: St.Button;
    private player: MediaPlayer | null = null;

    constructor(actions: MediaActions) {
        super({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-panel', x_expand: true});

        this.title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.artist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.add_child(this.title);
        text.add_child(this.artist);
        this.track.add_child(this.art);
        this.track.add_child(text);

        const withPlayer = (action: (busName: string) => void) => () => this.player && action(this.player.busName);
        this.previous = controlButton('media-skip-backward-symbolic', _('Previous'), withPlayer(b => actions.previous(b)));
        this.playPause = controlButton('media-playback-start-symbolic', _('Play or pause'), withPlayer(b => actions.playPause(b)));
        this.next = controlButton('media-skip-forward-symbolic', _('Next'), withPlayer(b => actions.next(b)));
        for (const button of [this.previous, this.playPause, this.next])
            this.controls.add_child(button);

        this.add_child(this.empty);
        this.add_child(this.track);
        this.add_child(this.controls);
        this.update(null);
    }

    update(player: MediaPlayer | null): void {
        this.player = player;
        this.empty.visible = !player;
        this.track.visible = Boolean(player);
        this.controls.visible = Boolean(player);
        if (!player)
            return;

        this.title.text = player.title;
        this.artist.text = player.artist;
        this.art.gicon = player.artUrl
            ? new Gio.FileIcon({file: Gio.File.new_for_uri(player.artUrl)})
            : Gio.ThemedIcon.new('audio-x-generic-symbolic');
        (this.playPause.child as St.Icon).icon_name = player.status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this.previous.reactive = player.canGoPrevious;
        this.next.reactive = player.canGoNext;
        this.playPause.reactive = player.canPlayPause;
    }
}
