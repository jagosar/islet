import GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {describeAgentEvent, parseAgentEvent} from './core/agentEvents.js';
import {compactClaudeText, secondsUntilPlanExpires} from './core/compact.js';
import {DaemonClient, type DaemonState} from './services/daemonClient.js';
import {Capsule, CapsuleSpacer} from './ui/capsule.js';

const CAPSULE_ROLE = 'islet-capsule';
const SPACER_ROLE = 'islet-spacer';

function nowSeconds(): number {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

export default class IsletExtension extends Extension {
    private capsule: Capsule | null = null;
    private spacer: CapsuleSpacer | null = null;
    private daemon: DaemonClient | null = null;
    private state: DaemonState | null = null;
    private refreshId = 0;
    private debug: {stop(): void} | null = null;

    enable(): void {
        this.daemon = new DaemonClient(`${this.path}/daemon/main.js`, {
            onState: state => this.onState(state),
            onAgentEvent: fields => this.onAgentEvent(fields),
        });
        this.capsule = new Capsule(() => this.simulateAgentEvent());
        this.capsule.setAvailable(false);

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
        this.clearRefresh();
        this.daemon?.stop();
        this.daemon = null;
        this.state = null;
        this.capsule?.destroy();
        this.capsule = null;
        this.spacer?.destroy();
        this.spacer = null;
    }

    private onState(state: DaemonState): void {
        this.state = state;
        this.render();
    }

    /** Renders the compact capsule from the daemon state, and refreshes once when it expires. */
    private render(): void {
        if (!this.capsule || !this.state)
            return;
        const now = nowSeconds();
        this.capsule.setAvailable(this.state.available);
        this.capsule.setCompactText(compactClaudeText(this.state.usage, this.state.plan, now));

        this.clearRefresh();
        const expiresIn = secondsUntilPlanExpires(this.state.plan, now);
        if (expiresIn !== null) {
            this.refreshId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, expiresIn, () => {
                this.refreshId = 0;
                this.render();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private clearRefresh(): void {
        if (this.refreshId) {
            GLib.source_remove(this.refreshId);
            this.refreshId = 0;
        }
    }

    private onAgentEvent(fields: Record<string, string>): void {
        const event = parseAgentEvent(fields);
        const text = event && describeAgentEvent(event, _);
        if (text)
            this.capsule?.showLiveActivity(text);
    }

    /** Spike: sends a fake permission prompt through the daemon and back. */
    private simulateAgentEvent(): void {
        this.daemon?.reportAgentEvent({
            session_id: 'simulated',
            cwd: GLib.build_filenamev([GLib.get_home_dir(), 'code', 'islet']),
            hook_event_name: 'Notification',
            notification_type: 'permission_prompt',
        });
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
