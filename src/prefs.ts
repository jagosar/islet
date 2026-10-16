// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {ClaudeConnection} from './services/claudeConnection.js';

const TOGGLE_KEY = 'toggle-island';

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export default class IsletPreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const page = new Adw.PreferencesPage({title: _('Islet'), icon_name: 'preferences-system-symbolic'});
        window.add(page);
        page.add(this.claudeGroup(window));
        page.add(this.keyboardGroup());
        page.add(this.aboutGroup());
        return Promise.resolve();
    }

    private claudeGroup(window: Adw.PreferencesWindow): Adw.PreferencesGroup {
        const connection = new ClaudeConnection(this.path);
        const group = new Adw.PreferencesGroup({
            title: _('Claude Code'),
            description: _('Usage is read from Claude Code’s transcripts without any setup. Connecting adds hooks for live agent alerts and a status line for plan usage to Claude Code’s settings.'),
        });
        const row = new Adw.ActionRow({title: _('Live alerts and plan usage')});
        const button = new Gtk.Button({valign: Gtk.Align.CENTER});
        row.add_suffix(button);
        group.add(row);

        const refresh = () => {
            const {hooks, statusLine, stale} = connection.status();
            const connected = hooks && statusLine && !stale;
            const partly = (hooks || statusLine) && !connected;
            row.subtitle = (connected ? _('Connected · %s') : partly ? _('Needs repair · %s') : _('Not connected · %s'))
                .replace('%s', connection.displayPath);
            button.label = connected ? _('Disconnect') : partly ? _('Repair…') : _('Connect…');
            button.remove_css_class(connected ? 'suggested-action' : 'destructive-action');
            button.add_css_class(connected ? 'destructive-action' : 'suggested-action');
        };

        const fail = (heading: string, error: unknown) => {
            const dialog = new Adw.AlertDialog({heading, body: errorMessage(error)});
            dialog.add_response('close', _('Close'));
            dialog.present(window);
        };

        button.connect('clicked', () => {
            const {hooks, statusLine, stale} = connection.status();
            if (hooks && statusLine && !stale)
                this.confirmDisconnect(window, connection, refresh, fail);
            else
                this.confirmConnect(window, connection, refresh, fail, (hooks || statusLine) ? 'repair' : 'connect');
        });
        refresh();
        return group;
    }

    private confirmConnect(window: Adw.PreferencesWindow, connection: ClaudeConnection, refresh: () => void,
        fail: (heading: string, error: unknown) => void, mode: 'connect' | 'repair' = 'connect'): void {
        let preview: string;
        try {
            preview = connection.preview();
        } catch (error) {
            fail(_('Islet cannot change Claude Code’s settings'), error);
            return;
        }

        const view = new Gtk.TextView({editable: false, monospace: true, wrap_mode: Gtk.WrapMode.CHAR, top_margin: 8, bottom_margin: 8, left_margin: 8, right_margin: 8});
        view.buffer.text = preview;
        const scroller = new Gtk.ScrolledWindow({child: view, min_content_height: 220, max_content_height: 320, propagate_natural_height: true});
        scroller.add_css_class('card');

        const repairing = mode === 'repair';
        const dialog = new Adw.AlertDialog({
            heading: repairing ? _('Repair the Claude Code connection?') : _('Connect Claude Code?'),
            body: (repairing
                ? _('The connection in %s is out of date (Islet moved, or it was made by an older version). Islet will replace its own entries with these. Everything else in the file is kept. Restart running Claude Code sessions afterwards.')
                : _('Islet will add these entries to %s. Everything else in the file is kept, an existing status line keeps working through Islet, a backup is saved next to it, and Disconnect removes exactly these entries. Restart running Claude Code sessions afterwards.'))
                .replace('%s', connection.displayPath),
            extra_child: scroller,
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('connect', repairing ? _('Repair') : _('Connect'));
        dialog.set_response_appearance('connect', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog: Adw.AlertDialog, response: string) => {
            if (response !== 'connect')
                return;
            try {
                if (repairing)
                    connection.repair();
                else
                    connection.connect();
            } catch (error) {
                fail(repairing ? _('Could not repair the connection') : _('Could not connect Claude Code'), error);
            }
            refresh();
        });
        dialog.present(window);
    }

    private confirmDisconnect(window: Adw.PreferencesWindow, connection: ClaudeConnection, refresh: () => void,
        fail: (heading: string, error: unknown) => void): void {
        const dialog = new Adw.AlertDialog({
            heading: _('Disconnect Claude Code?'),
            body: _('Islet will remove only its own entries from %s and restore your previous status line, if you had one.')
                .replace('%s', connection.displayPath),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('disconnect', _('Disconnect'));
        dialog.set_response_appearance('disconnect', Adw.ResponseAppearance.DESTRUCTIVE);
        dialog.connect('response', (_dialog: Adw.AlertDialog, response: string) => {
            if (response !== 'disconnect')
                return;
            try {
                connection.disconnect();
            } catch (error) {
                fail(_('Could not disconnect Claude Code'), error);
            }
            refresh();
        });
        dialog.present(window);
    }

    private keyboardGroup(): Adw.PreferencesGroup {
        const settings = this.getSettings();
        const group = new Adw.PreferencesGroup({
            title: _('Keyboard'),
            description: _('For example <Control><Alt>space or <Super>period. Esc closes the island.'),
        });
        const row = new Adw.EntryRow({
            title: _('Open the island'),
            text: settings.get_strv(TOGGLE_KEY)[0] ?? '',
            show_apply_button: true,
        });
        row.connect('changed', () => row.remove_css_class('error'));
        row.connect('apply', () => {
            const text = row.text.trim();
            const [valid, key] = Gtk.accelerator_parse(text);
            if (valid && key !== 0)
                settings.set_strv(TOGGLE_KEY, [text]);
            else
                row.add_css_class('error');
        });
        group.add(row);
        return group;
    }

    private aboutGroup(): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: _('About')});
        const version = String(this.metadata['version-name'] ?? this.metadata.version ?? '');
        group.add(new Adw.ActionRow({title: _('Version'), subtitle: version}));
        group.add(new Adw.ActionRow({
            title: _('Privacy'),
            subtitle: _('Everything stays on this computer. Islet reads token counts and session events, never your prompts or Claude’s replies, and sends nothing anywhere.'),
        }));
        const link = new Adw.ActionRow({title: _('Source code'), subtitle: String(this.metadata.url ?? ''), activatable: true});
        link.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        link.connect('activated', () => new Gtk.UriLauncher({uri: String(this.metadata.url ?? '')}).launch(null, null, null));
        group.add(link);
        return group;
    }
}
