// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {parseAgentEvent} from './core/agentEvents.js';
import {secondsUntilPlanExpires} from './core/compact.js';
import {remainingSeconds, type FocusState} from './core/focus.js';
import {LiveQueue, compactView, liveActivityForAgentEvent, planThresholdCrossed} from './core/island.js';
import {activePlayer, trackKey, trackLine, type MediaPlayer} from './core/media.js';
import {DaemonClient, type DaemonState} from './services/daemonClient.js';
import {FocusController} from './services/focusController.js';
import {formatLocal} from './services/localTime.js';
import {MprisClient} from './services/mprisClient.js';
import {Capsule, CapsuleSpacer} from './ui/capsule.js';
import {ClaudePanel} from './ui/claudePanel.js';
import {ExpandedView} from './ui/expandedView.js';
import {FocusPanel} from './ui/focusPanel.js';
import {MediaPanel} from './ui/mediaPanel.js';

const CAPSULE_ROLE = 'islet-capsule';
/** The GSettings key holding the shortcut that opens or closes the island. */
const TOGGLE_KEY = 'toggle-island';
const SPACER_ROLE = 'islet-spacer';
/** While the expanded view is open, relative times ("5 min ago") refresh this often. */
const PANEL_REFRESH_S = 30;
/** Players already playing when Islet starts are not announced as a new song. */
const MEDIA_SETTLE_MS = 3000;
const NO_DAEMON: DaemonState = {available: false, usage: null, plan: null, sessions: [], insights: null};

function nowSeconds(): number {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

function nowMs(): number {
    return Math.floor(GLib.get_monotonic_time() / 1000);
}

export default class IsletExtension extends Extension {
    private capsule: Capsule | null = null;
    private spacer: CapsuleSpacer | null = null;
    private expanded: ExpandedView | null = null;
    private panel: ClaudePanel | null = null;
    private mediaPanel: MediaPanel | null = null;
    private focusPanel: FocusPanel | null = null;
    private daemon: DaemonClient | null = null;
    private mpris: MprisClient | null = null;
    private focus: FocusController | null = null;
    private state: DaemonState | null = null;
    private player: MediaPlayer | null = null;
    private announcedTrack = '';
    private enabledAt = 0;
    private live = new LiveQueue();
    private sources = new Map<string, number>();
    // DEV-ONLY-BEGIN (left out of the packaged extension by scripts/pack.sh)
    private debug: {stop(): void} | null = null;
    // DEV-ONLY-END

    enable(): void {
        try {
            this.start();
        } catch (error) {
            // Whatever was built before the failure must not stay behind in the panel and the
            // session: undo it all, then let GNOME Shell see the error.
            this.disable();
            throw error;
        }
    }

    private start(): void {
        this.live = new LiveQueue();
        this.daemon = new DaemonClient(`${this.path}/daemon/main.js`, {
            onState: state => this.onState(state),
            onAgentEvent: fields => this.onAgentEvent(fields),
        });

        this.enabledAt = nowMs();
        this.mpris = new MprisClient(players => this.onPlayers(players));
        this.focus = new FocusController(state => this.onFocus(state), minutes => this.pushLive({
            key: 'focus',
            text: _('Focus done · %d min').replace('%d', String(minutes)),
            tone: 'attention',
            priority: 2,
        }));

        this.capsule = new Capsule();
        this.panel = new ClaudePanel();
        this.mediaPanel = new MediaPanel({
            playPause: busName => this.mpris?.playPause(busName),
            next: busName => this.mpris?.next(busName),
            previous: busName => this.mpris?.previous(busName),
        });
        this.focusPanel = new FocusPanel({
            start: minutes => this.focus?.start(minutes),
            pause: () => this.focus?.pause(),
            resume: () => this.focus?.resume(),
            stop: () => this.focus?.stop(),
        });
        this.expanded = new ExpandedView([
            {id: 'claude', title: _('Claude'), actor: this.panel},
            {id: 'media', title: _('Music'), actor: this.mediaPanel},
            {id: 'focus', title: _('Focus'), actor: this.focusPanel},
        ]);
        if (this.capsule.menu instanceof PopupMenu.PopupMenu) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            item.add_child(this.expanded);
            this.capsule.menu.addMenuItem(item);
            this.capsule.menu.connectObject('open-state-changed', (_menu: unknown, open: boolean) => this.onMenuToggled(open), this);
        }

        // Place the capsule right of the clock with a mirror spacer on its left, so the clock
        // stays centred. If another extension moved the clock out of the centre box, the
        // capsule just goes at the end of the centre box.
        const clock = Main.panel.statusArea.dateMenu?.container;
        const centerBox = clock?.get_parent();
        if (clock && centerBox?.name === 'panelCenter') {
            const clockIndex = centerBox.get_children().indexOf(clock);
            this.spacer = new CapsuleSpacer();
            Main.panel.addToStatusArea(SPACER_ROLE, this.spacer, clockIndex, 'center');
            Main.panel.addToStatusArea(CAPSULE_ROLE, this.capsule, clockIndex + 2, 'center');
            this.capsule.setMirror(this.spacer.container);
        } else {
            Main.panel.addToStatusArea(CAPSULE_ROLE, this.capsule, -1, 'center');
        }

        Main.wm.addKeybinding(TOGGLE_KEY, this.getSettings(), Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.capsule?.menu.toggle());

        this.daemon.start();
        this.mpris.start();
        this.focus.load();
        this.render();
        // DEV-ONLY-BEGIN
        this.startDevDebug();
        // DEV-ONLY-END
    }

    disable(): void {
        Main.wm.removeKeybinding(TOGGLE_KEY);
        // DEV-ONLY-BEGIN
        this.debug?.stop();
        this.debug = null;
        // DEV-ONLY-END
        for (const id of this.sources.values())
            GLib.source_remove(id);
        this.sources.clear();
        this.daemon?.stop();
        this.daemon = null;
        this.mpris?.destroy();
        this.mpris = null;
        this.focus?.destroy();
        this.focus = null;
        this.state = null;
        this.player = null;
        this.announcedTrack = '';
        this.live.clear();
        this.capsule?.menu.disconnectObject(this);
        this.capsule?.destroy();
        this.capsule = null;
        // Destroyed with the capsule's menu.
        this.expanded = null;
        this.panel = null;
        this.mediaPanel = null;
        this.focusPanel = null;
        this.spacer?.destroy();
        this.spacer = null;
    }

    // DEV-ONLY-BEGIN
    /**
     * Development only: scripts/nested.sh sets ISLET_DEV_DEBUG, and dev/ is left out of the
     * packaged extension, so release installs never load this.
     */
    private startDevDebug(): void {
        if (!GLib.getenv('ISLET_DEV_DEBUG') || !GLib.file_test(`${this.path}/dev/debugService.js`, GLib.FileTest.EXISTS))
            return;
        // Fault injection for the end-to-end test of enable()'s rollback; like the debug service,
        // it exists only where dev/ was not stripped (never in the package).
        if (GLib.getenv('ISLET_DEV_FAIL_ENABLE'))
            throw new Error('ISLET_DEV_FAIL_ENABLE: simulated failure at the end of enable()');
        import('./dev/debugService.js')
            .then(({DebugService}) => {
                if (this.capsule && this.expanded)
                    this.debug = new DebugService(this.capsule, this.expanded);
            })
            .catch((error: unknown) => console.warn(`Islet: debug service unavailable: ${String(error)}`));
    }
    // DEV-ONLY-END

    private onState(state: DaemonState): void {
        const crossed = this.state?.available ? planThresholdCrossed(this.state.plan, state.plan) : null;
        this.state = state;
        if (crossed !== null && state.plan?.fiveHour) {
            const resetsAt = state.plan.fiveHour.resetsAt;
            this.pushLive({
                key: 'plan',
                text: resetsAt === undefined
                    ? _('Claude plan at %s').replace('%s', `${crossed}%`)
                    : _('Claude plan at %s · resets %s').replace('%s', `${crossed}%`).replace('%s', formatLocal(resetsAt, '%H:%M')),
                tone: 'attention',
                priority: 2,
            });
        }
        this.render();
        if (this.capsule?.menu instanceof PopupMenu.PopupMenu && this.capsule.menu.isOpen)
            this.panel?.update(state);
    }

    private onAgentEvent(fields: Record<string, string>): void {
        const event = parseAgentEvent(fields);
        const activity = event && liveActivityForAgentEvent(event, _);
        if (activity)
            this.pushLive(activity);
    }

    private onPlayers(players: MediaPlayer[]): void {
        this.player = activePlayer(players);
        const key = trackKey(this.player);
        const settled = nowMs() - this.enabledAt > MEDIA_SETTLE_MS;
        if (this.player?.status === 'Playing' && key !== this.announcedTrack) {
            if (settled)
                this.pushLive({key: 'media', text: `♪ ${trackLine(this.player)}`, tone: 'normal', priority: 0});
            this.announcedTrack = key;
        }
        this.mediaPanel?.update(this.player);
        this.render();
    }

    private onFocus(state: FocusState): void {
        this.focusPanel?.update(state);
        this.render();
    }

    /**
     * Renders the compact capsule; refreshes once when the plan percentage expires, and every
     * second while a focus countdown is shown.
     */
    private render(): void {
        if (!this.capsule)
            return;
        const now = nowSeconds();
        const state = this.state ?? NO_DAEMON;
        const timer = this.focus?.current.timer;
        const focus = timer && timer.status !== 'idle'
            ? {remainingS: remainingSeconds(timer, now), paused: timer.status === 'paused'}
            : null;
        const nowPlaying = this.player?.status === 'Playing' ? trackLine(this.player) : null;
        this.capsule.setCompact(compactView({...state, now, focus, nowPlaying}, _));

        const expiresIn = secondsUntilPlanExpires(state.plan, now);
        this.schedule('plan-expiry', expiresIn === null ? null : expiresIn * 1000, () => this.render());
        this.schedule('focus-tick', timer?.status === 'running' ? 1000 : null, () => {
            if (this.focus)
                this.focusPanel?.update(this.focus.current);
            this.render();
        });
    }

    private pushLive(activity: Parameters<LiveQueue['push']>[0]): void {
        if (this.live.push(activity, nowMs()))
            this.showLive();
    }

    private showLive(): void {
        this.capsule?.setLive(this.live.shown);
        const next = this.live.nextChangeAt();
        this.schedule('live', next === null ? null : Math.max(0, next - nowMs()), () => {
            if (this.live.tick(nowMs()))
                this.showLive();
        });
    }

    private onMenuToggled(open: boolean): void {
        if (open && this.state)
            this.panel?.update(this.state);
        // The menu manager sets key focus after this signal, so take it on the next cycle.
        this.schedule('focus-tab', open ? 0 : null, () => this.expanded?.focusSelectedTab());
        const refresh = () => {
            this.panel?.refresh();
            this.schedule('panel', PANEL_REFRESH_S * 1000, refresh);
        };
        this.schedule('panel', open ? PANEL_REFRESH_S * 1000 : null, refresh);
    }

    /** One timer per name: replaces the previous one; null just cancels. */
    private schedule(name: string, delayMs: number | null, callback: () => void): void {
        const existing = this.sources.get(name);
        if (existing)
            GLib.source_remove(existing);
        this.sources.delete(name);
        if (delayMs === null)
            return;
        this.sources.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this.sources.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }
}
