/**
 * What the capsule shows: the compact view chosen from the current state, and the queue of
 * temporary live activities. Pure, so every rule is unit tested.
 */
import {describeAgentEvent, type AgentEvent} from './agentEvents.js';
import {compactClaudeText} from './compact.js';
import {formatCountdown} from './focus.js';
import type {AgentSession, PlanUsage, UsageSnapshot} from './protocol.js';

export type Tone = 'normal' | 'attention' | 'muted';

export interface CompactView {
    text: string;
    tone: Tone;
}

export interface IslandInput {
    available: boolean;
    usage: UsageSnapshot | null;
    plan: PlanUsage | null;
    sessions: AgentSession[];
    /** Unix epoch seconds. */
    now: number;
    /** A focus session in progress, if any. */
    focus?: {remainingS: number; paused: boolean} | null;
    /** The track shown when nothing else has news: "Title — Artist" while playing. */
    nowPlaying?: string | null;
}

type Translate = (text: string) => string;
const identity: Translate = text => text;

/** What compactClaudeText shows without any data. */
const CLAUDE_IDLE = 'Claude';

/** Sessions that wait for the user, most urgent first (the list is already sorted). */
export function sessionsNeedingYou(sessions: AgentSession[]): AgentSession[] {
    return sessions.filter(s => s.state === 'needs-permission' || s.state === 'waiting');
}

/**
 * The compact capsule. Order of precedence: Claude sessions that need the user (they stay until
 * the session moves on), a focus session, Claude usage, what is playing, and finally "Claude".
 * Focus and music work without the daemon; Claude data needs it.
 */
export function compactView(input: IslandInput, t: Translate = identity): CompactView {
    const needing = input.available ? sessionsNeedingYou(input.sessions) : [];
    if (needing.length > 1)
        return {text: t('%d sessions need you').replace('%d', String(needing.length)), tone: 'attention'};
    if (needing.length === 1) {
        const [session] = needing;
        const text = session.state === 'needs-permission' ? t('%s needs permission') : t('%s is waiting');
        return {text: text.replace('%s', session.project), tone: 'attention'};
    }

    if (input.focus) {
        const countdown = formatCountdown(input.focus.remainingS);
        return input.focus.paused
            ? {text: t('Focus paused · %s').replace('%s', countdown), tone: 'muted'}
            : {text: t('Focus %s').replace('%s', countdown), tone: 'normal'};
    }

    const claude = input.available ? compactClaudeText(input.usage, input.plan, input.now) : CLAUDE_IDLE;
    if (claude !== CLAUDE_IDLE)
        return {text: claude, tone: 'normal'};
    if (input.nowPlaying)
        return {text: `♪ ${input.nowPlaying}`, tone: 'normal'};
    return {text: CLAUDE_IDLE, tone: input.available ? 'normal' : 'muted'};
}

/** The live activity for an agent event, or null for events that should not interrupt. */
export function liveActivityForAgentEvent(event: AgentEvent, t: Translate = identity): LiveActivity | null {
    const text = describeAgentEvent(event, t);
    if (!text)
        return null;
    const needsUser = event.hookEventName === 'Notification' &&
        ['permission_prompt', 'idle_prompt', 'agent_needs_input'].includes(event.notificationType ?? '');
    const priority = event.notificationType === 'permission_prompt' ? 3 : needsUser ? 2 : 1;
    return {key: `session:${event.sessionId}`, text, tone: needsUser ? 'attention' : 'normal', priority};
}

/** Plan thresholds that raise a live activity when the 5-hour window crosses them upward. */
export const PLAN_THRESHOLDS = [75, 90] as const;

/** The highest threshold crossed between two plan readings, or null. */
export function planThresholdCrossed(previous: PlanUsage | null, next: PlanUsage | null): number | null {
    const before = previous?.fiveHour?.usedPercentage ?? 0;
    const after = next?.fiveHour?.usedPercentage;
    if (after === undefined)
        return null;
    // A new 5-hour window starts from zero; compare within the same window only.
    const sameWindow = previous?.fiveHour?.resetsAt === next?.fiveHour?.resetsAt;
    const from = sameWindow ? before : 0;
    const crossed = PLAN_THRESHOLDS.filter(threshold => from < threshold && after >= threshold);
    return crossed.length ? crossed[crossed.length - 1] : null;
}

export interface LiveActivity {
    /** Activities with the same key replace each other (e.g. repeated events of one session). */
    key: string;
    text: string;
    tone: Tone;
    /** Higher interrupts lower. */
    priority: number;
}

export const LIVE_ACTIVITY_MS = 4000;
/** A queued activity older than this is no longer news and is dropped. */
export const LIVE_ACTIVITY_STALE_MS = 15000;
const MAX_WAITING = 3;

interface Queued {
    activity: LiveActivity;
    queuedAt: number;
}

/**
 * Live activities shown one at a time for LIVE_ACTIVITY_MS. A more important one interrupts the
 * current one (which is not shown again); others wait their turn, at most three, and are
 * dropped once stale. Times are milliseconds from any monotonic clock.
 */
export class LiveQueue {
    private current: {activity: LiveActivity; until: number} | null = null;
    private waiting: Queued[] = [];

    get shown(): LiveActivity | null {
        return this.current?.activity ?? null;
    }

    /** Adds an activity; returns true if what is shown changed. */
    push(activity: LiveActivity, now: number): boolean {
        this.waiting = this.waiting.filter(q => q.activity.key !== activity.key);

        if (this.current && this.current.activity.key === activity.key) {
            this.current = {activity, until: now + LIVE_ACTIVITY_MS};
            return true;
        }
        if (!this.current || activity.priority > this.current.activity.priority) {
            this.current = {activity, until: now + LIVE_ACTIVITY_MS};
            return true;
        }
        this.waiting.push({activity, queuedAt: now});
        this.waiting.sort((a, b) => b.activity.priority - a.activity.priority || a.queuedAt - b.queuedAt);
        this.waiting = this.waiting.slice(0, MAX_WAITING);
        return false;
    }

    /** Ends the current activity if its time is up and shows the next one; true if changed. */
    tick(now: number): boolean {
        if (!this.current || now < this.current.until)
            return false;
        this.waiting = this.waiting.filter(q => now - q.queuedAt < LIVE_ACTIVITY_STALE_MS);
        const next = this.waiting.shift();
        this.current = next ? {activity: next.activity, until: now + LIVE_ACTIVITY_MS} : null;
        return true;
    }

    /** When tick() next has something to do, or null if nothing is shown. */
    nextChangeAt(): number | null {
        return this.current?.until ?? null;
    }

    clear(): void {
        this.current = null;
        this.waiting = [];
    }
}
