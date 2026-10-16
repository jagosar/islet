import GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {parseAgentEvent} from './core/agentEvents.js';
import {secondsUntilPlanExpires} from './core/compact.js';
import {LiveQueue, compactView, liveActivityForAgentEvent, planThresholdCrossed} from './core/island.js';
import {DaemonClient, type DaemonState} from './services/daemonClient.js';
import {Capsule, CapsuleSpacer} from './ui/capsule.js';
import {ClaudePanel} from './ui/claudePanel.js';

const CAPSULE_ROLE = 'islet-capsule';
const SPACER_ROLE = 'islet-spacer';
/** While the expanded view is open, relative times ("5 min ago") refresh this often. */
const PANEL_REFRESH_S = 30;

function nowSeconds(): number {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

function nowMs(): number {
    return Math.floor(GLib.get_monotonic_time() / 1000);
}

export default class IsletExtension extends Extension {
    private capsule: Capsule | null = null;
    private spacer: CapsuleSpacer | null = null;
    private panel: ClaudePanel | null = null;
    private daemon: DaemonClient | null = null;
    private state: DaemonState | null = null;
    private live = new LiveQueue();
    private sources = new Map<string, number>();
    private debug: {stop(): void} | null = null;

    enable(): void {
        this.live = new LiveQueue();
        this.daemon = new DaemonClient(`${this.path}/daemon/main.js`, {
            onState: state => this.onState(state),
            onAgentEvent: fields => this.onAgentEvent(fields),
        });

        this.capsule = new Capsule();
        this.panel = new ClaudePanel();
        if (this.capsule.menu instanceof PopupMenu.PopupMenu) {
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            item.add_child(this.panel);
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

        this.daemon.start();
        this.startDevDebug();
    }

    disable(): void {
        this.debug?.stop();
        this.debug = null;
        for (const id of this.sources.values())
            GLib.source_remove(id);
        this.sources.clear();
        this.daemon?.stop();
        this.daemon = null;
        this.state = null;
        this.live.clear();
        this.capsule?.menu.disconnectObject(this);
        this.capsule?.destroy();
        this.capsule = null;
        this.panel = null; // Destroyed with the capsule's menu.
        this.spacer?.destroy();
        this.spacer = null;
    }

    private onState(state: DaemonState): void {
        const crossed = this.state?.available ? planThresholdCrossed(this.state.plan, state.plan) : null;
        this.state = state;
        if (crossed !== null && state.plan?.fiveHour) {
            const reset = GLib.DateTime.new_from_unix_local(state.plan.fiveHour.resetsAt)?.format('%H:%M') ?? '';
            this.pushLive({
                key: 'plan',
                text: _('Claude plan at %s · resets %s').replace('%s', `${crossed}%`).replace('%s', reset),
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

    /** Renders the compact capsule, and refreshes once when the plan percentage expires. */
    private render(): void {
        if (!this.capsule || !this.state)
            return;
        const now = nowSeconds();
        this.capsule.setCompact(compactView({...this.state, now}, _));

        const expiresIn = secondsUntilPlanExpires(this.state.plan, now);
        this.schedule('plan-expiry', expiresIn === null ? null : expiresIn * 1000, () => this.render());
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

    /**
     * Development only: scripts/nested.sh sets ISLET_DEV_DEBUG, and dev/ is left out of the
     * packaged extension, so release installs never load this.
     */
    private startDevDebug(): void {
        if (!GLib.getenv('ISLET_DEV_DEBUG'))
            return;
        import('./dev/debugService.js')
            .then(({DebugService}) => {
                if (this.capsule)
                    this.debug = new DebugService(this.capsule);
            })
            .catch(error => console.warn(`Islet: debug service unavailable: ${error}`));
    }
}
