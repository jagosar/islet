import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

export interface Page {
    id: string;
    title: string;
    actor: St.Widget;
}

/** The expanded island: a row of tabs and the selected page below it. */
export class ExpandedView extends St.BoxLayout {
    static {
        GObject.registerClass(this);
    }

    private readonly buttons = new Map<string, St.Button>();
    private readonly pages = new Map<string, St.Widget>();
    private selected = '';

    constructor(pages: Page[]) {
        super({orientation: Clutter.Orientation.VERTICAL, style_class: 'islet-expanded'});

        const tabs = new St.BoxLayout({style_class: 'islet-tabs', x_align: Clutter.ActorAlign.CENTER});
        this.add_child(tabs);
        for (const page of pages) {
            const button = new St.Button({label: page.title, style_class: 'islet-tab', can_focus: true, toggle_mode: false});
            button.connect('clicked', () => this.select(page.id));
            tabs.add_child(button);
            this.buttons.set(page.id, button);
            this.pages.set(page.id, page.actor);
            this.add_child(page.actor);
        }
        if (pages.length)
            this.select(pages[0].id);
    }

    get selectedPage(): string {
        return this.selected;
    }

    select(id: string): void {
        if (!this.pages.has(id))
            return;
        this.selected = id;
        for (const [pageId, actor] of this.pages)
            actor.visible = pageId === id;
        for (const [pageId, button] of this.buttons)
            button.checked = pageId === id;
    }
}
