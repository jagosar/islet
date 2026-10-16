import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {
    FOCUS_HISTORY_DAYS, completeIfDue, decodeFocusState, initialFocusState, pause, pruneHistory, resume, start, stop,
    type FocusState,
} from '../core/focus.js';

function nowSeconds(): number {
    return Math.floor(GLib.get_real_time() / 1_000_000);
}

function localDay(epochSeconds: number): string {
    return GLib.DateTime.new_from_unix_local(epochSeconds)?.format('%Y-%m-%d') ?? '';
}

/** Today and the days before it that the history keeps. */
export function keptDays(now: number): string[] {
    return Array.from({length: FOCUS_HISTORY_DAYS}, (_, i) => localDay(now - i * 86400));
}

/**
 * The focus timer in the Shell: applies the pure operations, saves the state to
 * $XDG_STATE_HOME/islet/focus.json asynchronously, and fires once when the session is due.
 */
export class FocusController {
    private readonly file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_state_dir(), 'islet', 'focus.json']));
    private readonly cancellable = new Gio.Cancellable();
    private state: FocusState = initialFocusState();
    private dueId = 0;

    constructor(
        private readonly onChange: (state: FocusState) => void,
        private readonly onCompleted: (minutes: number) => void,
    ) {}

    get current(): FocusState {
        return this.state;
    }

    load(): void {
        this.file.load_contents_async(this.cancellable, (_file, result) => {
            let text = '';
            try {
                const [, bytes] = this.file.load_contents_finish(result);
                text = new TextDecoder().decode(bytes);
            } catch {
                if (this.cancellable.is_cancelled())
                    return;
                // No saved state yet.
            }
            this.state = decodeFocusState(text);
            this.apply(this.state, false);
        });
    }

    start(minutes: number): void {
        this.apply(start(this.state, minutes, nowSeconds()));
    }

    pause(): void {
        this.apply(pause(this.state, nowSeconds()));
    }

    resume(): void {
        this.apply(resume(this.state, nowSeconds()));
    }

    stop(): void {
        this.apply(stop(this.state, nowSeconds(), localDay(nowSeconds())));
    }

    destroy(): void {
        this.cancellable.cancel();
        if (this.dueId)
            GLib.source_remove(this.dueId);
        this.dueId = 0;
    }

    /** Completes a due session, prunes old days, saves, schedules and notifies. */
    private apply(next: FocusState, save = true): void {
        const now = nowSeconds();
        let state = next;
        let completedMinutes = 0;
        if (state.timer.status === 'running' && now >= state.timer.endsAt) {
            completedMinutes = Math.round(state.timer.durationS / 60);
            state = completeIfDue(state, now, localDay(state.timer.endsAt)).state;
            save = true;
        }
        state = pruneHistory(state, keptDays(now));

        const changed = JSON.stringify(state) !== JSON.stringify(this.state);
        this.state = state;
        if (save && changed)
            this.save();
        this.scheduleDue();
        this.onChange(state);
        if (completedMinutes)
            this.onCompleted(completedMinutes);
    }

    private scheduleDue(): void {
        if (this.dueId)
            GLib.source_remove(this.dueId);
        this.dueId = 0;
        const {timer} = this.state;
        if (timer.status !== 'running')
            return;
        const delay = Math.max(0, timer.endsAt - nowSeconds());
        this.dueId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this.dueId = 0;
            this.apply(this.state);
            return GLib.SOURCE_REMOVE;
        });
    }

    private save(): void {
        try {
            GLib.mkdir_with_parents(this.file.get_parent()!.get_path()!, 0o700);
        } catch {
            // replace_contents_async reports the error below.
        }
        const bytes = new TextEncoder().encode(JSON.stringify(this.state));
        this.file.replace_contents_async(bytes, null, false, Gio.FileCreateFlags.PRIVATE, this.cancellable, (_file, result) => {
            try {
                this.file.replace_contents_finish(result);
            } catch (error) {
                if (!this.cancellable.is_cancelled())
                    console.warn(`Islet: could not save the focus timer: ${error}`);
            }
        });
    }
}
