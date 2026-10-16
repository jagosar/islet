import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {readMetadata, readStatus, type MediaPlayer} from '../core/media.js';

const NAME_PREFIX = 'org.mpris.MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';
const CALL_TIMEOUT_MS = 1000;
const PLAYER_XML = `
<node>
  <interface name="${PLAYER_INTERFACE}">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
  </interface>
</node>`;

interface Tracked {
    proxy: Gio.DBusProxy;
    changedAt: number;
}

/**
 * Follows every MPRIS player on the session bus. GNOME Shell has its own MPRIS client, but it
 * offers no way to be torn down, and an extension must undo everything in disable(); this one
 * does, in destroy().
 */
export class MprisClient {
    private readonly cancellable = new Gio.Cancellable();
    private readonly info = Gio.DBusNodeInfo.new_for_xml(PLAYER_XML).lookup_interface(PLAYER_INTERFACE);
    private readonly players = new Map<string, Tracked>();
    private nameOwnerId = 0;

    constructor(private readonly onChange: (players: MediaPlayer[]) => void) {}

    start(): void {
        this.nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus',
            NAME_PREFIX, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_connection, _sender, _path, _iface, _signal, parameters) => {
                const [name, oldOwner, newOwner] = parameters.deepUnpack() as [string, string, string];
                if (oldOwner)
                    this.remove(name);
                if (newOwner)
                    this.add(name);
            });

        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, this.cancellable,
            (connection, result) => {
                try {
                    const [names] = connection!.call_finish(result).deepUnpack() as [string[]];
                    names.filter(name => name.startsWith(`${NAME_PREFIX}.`)).forEach(name => this.add(name));
                } catch (error) {
                    if (!this.cancellable.is_cancelled())
                        console.warn(`Islet: could not list media players: ${error}`);
                }
            });
    }

    /** The players with their current track, newest change last. */
    snapshot(): MediaPlayer[] {
        return [...this.players].map(([busName, {proxy, changedAt}]) => {
            const value = (name: string): unknown => proxy.get_cached_property(name)?.recursiveUnpack();
            const metadata = value('Metadata');
            return {
                busName,
                status: readStatus(value('PlaybackStatus')),
                ...readMetadata(typeof metadata === 'object' && metadata !== null ? metadata as Record<string, unknown> : {}),
                canGoNext: value('CanGoNext') === true,
                canGoPrevious: value('CanGoPrevious') === true,
                canPlayPause: value('CanPlay') === true || value('CanPause') === true,
                changedAt,
            };
        });
    }

    playPause(busName: string): void {
        this.call(busName, 'PlayPause');
    }

    next(busName: string): void {
        this.call(busName, 'Next');
    }

    previous(busName: string): void {
        this.call(busName, 'Previous');
    }

    destroy(): void {
        this.cancellable.cancel();
        if (this.nameOwnerId)
            Gio.DBus.session.signal_unsubscribe(this.nameOwnerId);
        this.nameOwnerId = 0;
        for (const {proxy} of this.players.values())
            proxy.disconnectObject(this);
        this.players.clear();
    }

    private add(busName: string): void {
        if (this.players.has(busName))
            return;
        Gio.DBusProxy.new(
            Gio.DBus.session, Gio.DBusProxyFlags.NONE, this.info, busName, '/org/mpris/MediaPlayer2',
            PLAYER_INTERFACE, this.cancellable,
            (_source, result) => {
                let proxy: Gio.DBusProxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(result);
                } catch {
                    return; // Cancelled, or the player left already.
                }
                if (this.players.has(busName))
                    return;
                this.players.set(busName, {proxy, changedAt: GLib.get_monotonic_time() / 1000});
                proxy.connectObject('g-properties-changed', () => {
                    const tracked = this.players.get(busName);
                    if (tracked)
                        tracked.changedAt = GLib.get_monotonic_time() / 1000;
                    this.emit();
                }, this);
                this.emit();
            });
    }

    private remove(busName: string): void {
        const tracked = this.players.get(busName);
        if (!tracked)
            return;
        tracked.proxy.disconnectObject(this);
        this.players.delete(busName);
        this.emit();
    }

    private call(busName: string, method: string): void {
        this.players.get(busName)?.proxy.call(method, null, Gio.DBusCallFlags.NONE, CALL_TIMEOUT_MS, this.cancellable, null);
    }

    private emit(): void {
        this.onChange(this.snapshot());
    }
}
