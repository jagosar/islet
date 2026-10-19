// SPDX-License-Identifier: GPL-2.0-or-later

// Development only. Loaded by the extension when ISLET_DEV_DEBUG is set (scripts/nested.sh does
// this) and left out of the packaged extension by scripts/pack.sh. It lets scripts inspect the
// capsule and take screenshots of the nested Shell, which has no other way in from outside.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Capsule} from '../ui/capsule.js';
import type {ClaudePanel} from '../ui/claudePanel.js';
import type {ExpandedView} from '../ui/expandedView.js';

const BUS_NAME = 'io.github.jagosar.IsletDebug';
const OBJECT_PATH = '/io/github/jagosar/IsletDebug';
const XML = `
<node>
  <interface name="io.github.jagosar.IsletDebug">
    <method name="State"><arg type="s" direction="out"/></method>
    <method name="Screenshot"><arg type="s" name="path" direction="in"/></method>
    <method name="ToggleMenu"/>
    <method name="SelectPage"><arg type="s" name="id" direction="in"/></method>
    <method name="PressKeys"><arg type="s" name="combo" direction="in"/></method>
    <method name="Click"><arg type="d" name="x" direction="in"/><arg type="d" name="y" direction="in"/></method>
  </interface>
</node>`;

function box(actor: {get_transformed_position(): [number, number]; width: number} | null | undefined) {
    if (!actor)
        return null;
    const [x] = actor.get_transformed_position();
    return {x: Math.round(x), width: Math.round(actor.width), center: Math.round(x + actor.width / 2)};
}

function describeFocus(actor: Clutter.Actor | null): string | null {
    if (!actor)
        return null;
    const widget = actor as Clutter.Actor & {style_class?: string | null; label?: string | null};
    return [actor.constructor.name, widget.style_class ?? '', widget.label ?? ''].join(':');
}

export class DebugService {
    private readonly exported: Gio.DBusExportedObject;
    private readonly ownerId: number;

    constructor(private readonly capsule: Capsule, private readonly expanded: ExpandedView, private readonly panel: ClaudePanel) {
        this.exported = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this.exported.export(Gio.DBus.session, OBJECT_PATH);
        this.ownerId = Gio.bus_own_name_on_connection(Gio.DBus.session, BUS_NAME, Gio.BusNameOwnerFlags.REPLACE, null, null);
    }

    State(): string {
        const menu = this.capsule.menu as {isOpen?: boolean};
        return JSON.stringify({
            shownText: this.capsule.shownText,
            compactText: this.capsule.compactText,
            live: this.capsule.isLive,
            available: this.capsule.isAvailable,
            menuOpen: Boolean(menu.isOpen),
            page: this.expanded.selectedPage,
            pages: this.expanded.pageIds,
            planBars: this.panel.planBars,
            keyFocus: describeFocus(global.stage.get_key_focus()),
            capsule: box(this.capsule.container),
            spacerWidth: this.capsule.mirrorWidth,
            capsulePreferred: Math.round(this.capsule.container.get_preferred_width(-1)[1]),
            contentPreferred: Math.round(this.capsule.get_preferred_width(-1)[1]),
            capsuleTransition: Boolean(this.capsule.container.get_transition('width')),
            clock: box(Main.panel.statusArea.dateMenu?.container),
            stageWidth: global.stage.width,
        });
    }

    ScreenshotAsync([path]: [string], invocation: Gio.DBusMethodInvocation): void {
        const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
        new Shell.Screenshot().screenshot(false, stream, (shooter, result) => {
            try {
                shooter?.screenshot_finish(result);
                stream.close(null);
                invocation.return_value(null);
            } catch (error) {
                invocation.return_dbus_error('org.freedesktop.DBus.Error.Failed', String(error));
            }
        });
    }

    ToggleMenu(): void {
        this.capsule.menu.toggle();
    }

    SelectPage(id: string): void {
        this.expanded.select(id);
    }

    /** Presses and releases keys like "Control_L+Alt_L+space" through a virtual keyboard. */
    PressKeys(combo: string): void {
        const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const keyvals = combo.split('+').map(name => (Clutter as unknown as Record<string, number>)[`KEY_${name}`]);
        let time = Math.floor(global.get_current_time() * 1000);
        for (const keyval of keyvals)
            keyboard.notify_keyval(time++, keyval, Clutter.KeyState.PRESSED);
        for (const keyval of [...keyvals].reverse())
            keyboard.notify_keyval(time++, keyval, Clutter.KeyState.RELEASED);
    }

    /** Moves a virtual pointer to (x, y) in stage coordinates and clicks. */
    Click(x: number, y: number): void {
        const pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        let time = Math.floor(global.get_current_time() * 1000);
        pointer.notify_absolute_motion(time++, x, y);
        pointer.notify_button(time++, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
        pointer.notify_button(time, Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
    }

    stop(): void {
        Gio.bus_unown_name(this.ownerId);
        this.exported.unexport();
    }
}
