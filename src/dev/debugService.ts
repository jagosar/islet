// Development only. Loaded by the extension when ISLET_DEV_DEBUG is set (scripts/nested.sh does
// this) and left out of the packaged extension by scripts/pack.sh. It lets scripts inspect the
// capsule and take screenshots of the nested Shell, which has no other way in from outside.

import Gio from 'gi://Gio';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Capsule} from '../ui/capsule.js';

const BUS_NAME = 'io.github.jagosar.IsletDebug';
const OBJECT_PATH = '/io/github/jagosar/IsletDebug';
const XML = `
<node>
  <interface name="io.github.jagosar.IsletDebug">
    <method name="State"><arg type="s" direction="out"/></method>
    <method name="Screenshot"><arg type="s" name="path" direction="in"/></method>
    <method name="ToggleMenu"/>
  </interface>
</node>`;

function box(actor: {get_transformed_position(): [number, number]; width: number} | null | undefined) {
    if (!actor)
        return null;
    const [x] = actor.get_transformed_position();
    return {x: Math.round(x), width: Math.round(actor.width), center: Math.round(x + actor.width / 2)};
}

export class DebugService {
    private readonly exported: Gio.DBusExportedObject;
    private readonly ownerId: number;

    constructor(private readonly capsule: Capsule) {
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
            capsule: box(this.capsule.container),
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

    stop(): void {
        Gio.bus_unown_name(this.ownerId);
        this.exported.unexport();
    }
}
