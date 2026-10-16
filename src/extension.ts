import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Capsule, CapsuleSpacer} from './ui/capsule.js';

const CAPSULE_ROLE = 'islet-capsule';
const SPACER_ROLE = 'islet-spacer';

export default class IsletExtension extends Extension {
    private capsule: Capsule | null = null;
    private spacer: CapsuleSpacer | null = null;

    enable(): void {
        this.capsule = new Capsule();

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
    }

    disable(): void {
        this.capsule?.destroy();
        this.capsule = null;
        this.spacer?.destroy();
        this.spacer = null;
    }
}
