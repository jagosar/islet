// SPDX-License-Identifier: GPL-2.0-or-later
/**
 * Connecting Islet to Claude Code by editing its settings.json: hooks for agent events and the
 * status line for plan usage. Pure, so every rule is unit tested; the callers read and write
 * the file.
 *
 * Rules: only Islet's own entries are added or removed (recognised by BRIDGE_MARKER in their
 * command); everything else is kept; an existing status line is chained, not replaced; and the
 * generated commands do nothing harmful if Islet is uninstalled without disconnecting.
 */

/** Every command Islet adds contains this path fragment, and no other command does. */
export const BRIDGE_MARKER = 'islet@jagosar.github.io/bridge/';

export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop', 'Notification'] as const;
const HOOK_TIMEOUT_S = 5;

export class SettingsError extends Error {}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Quotes a string for POSIX sh. */
export function shellQuote(text: string): string {
    return `'${text.replaceAll("'", `'\\''`)}'`;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of the UTF-8 bytes of `text` (no dependency on btoa, which GJS may lack). */
export function toBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
        const n = (a << 16) | (b << 8) | c;
        out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] +
            (i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=') +
            (i + 2 < bytes.length ? BASE64[n & 63] : '=');
    }
    return out;
}

export function fromBase64(encoded: string): string {
    const clean = encoded.replace(/=+$/, '');
    const bytes: number[] = [];
    let buffer = 0;
    let bits = 0;
    for (const char of clean) {
        const value = BASE64.indexOf(char);
        if (value < 0)
            throw new SettingsError('invalid base64');
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            bytes.push((buffer >> bits) & 255);
        }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * The hook command: runs the bridge with gjs if Islet is installed, and otherwise does nothing
 * and succeeds, so an uninstalled Islet never shows hook errors in Claude Code.
 */
export function hookCommand(hookScript: string): string {
    return `sh -c 'f="$1"; [ -f "$f" ] && exec gjs -m "$f"; exit 0' islet ${shellQuote(hookScript)}`;
}

/**
 * The status line command: runs the bridge, passing the user's previous status line command
 * (base64) to chain it; if Islet is gone, runs the previous command directly.
 */
export function statusLineCommand(statusLineScript: string, previousCommand: string | null): string {
    const previous = previousCommand ? toBase64(previousCommand) : '';
    return `sh -c 'f="$1"; p="$2"; [ -f "$f" ] && exec gjs -m "$f" "$p"; [ -n "$p" ] && exec sh -c "$(printf %s "$p" | base64 -d)"; exit 0' ` +
        `islet ${shellQuote(statusLineScript)} ${shellQuote(previous)}`;
}

/** The previous command chained in one of Islet's status line commands, or null. */
export function chainedPreviousCommand(command: string): string | null {
    const match = /' islet '[^']*' '([A-Za-z0-9+/=]*)'$/.exec(command);
    return match && match[1] ? fromBase64(match[1]) : null;
}

function isOurs(entry: unknown): boolean {
    return isObject(entry) && typeof entry.command === 'string' && entry.command.includes(BRIDGE_MARKER);
}

function parse(text: string | null): Json {
    if (text === null || text.trim() === '')
        return {};
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new SettingsError(`settings.json is not valid JSON (${error instanceof Error ? error.message : error}); Islet will not change it.`);
    }
    if (!isObject(value))
        throw new SettingsError('settings.json does not contain a JSON object; Islet will not change it.');
    return value;
}

function serialize(settings: Json): string {
    return `${JSON.stringify(settings, null, 2)}\n`;
}

export interface ConnectionStatus {
    hooks: boolean;
    statusLine: boolean;
}

export function connectionStatus(text: string | null): ConnectionStatus {
    let settings: Json;
    try {
        settings = parse(text);
    } catch {
        return {hooks: false, statusLine: false};
    }
    const hooks = isObject(settings.hooks) ? settings.hooks : {};
    const hasHook = Object.values(hooks).some(groups => Array.isArray(groups) &&
        groups.some(group => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isOurs)));
    return {hooks: hasHook, statusLine: isOurs(settings.statusLine)};
}

export interface BridgeScripts {
    hook: string;
    statusLine: string;
}

/** The entries connect() adds, for showing them to the user before connecting. */
export function plannedEntries(text: string | null, scripts: BridgeScripts): Json {
    const settings = parse(text);
    const previous = isObject(settings.statusLine) && typeof settings.statusLine.command === 'string' && !isOurs(settings.statusLine)
        ? settings.statusLine.command
        : null;
    const hook = {type: 'command', command: hookCommand(scripts.hook), timeout: HOOK_TIMEOUT_S};
    return {
        hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, [{hooks: [hook]}]])),
        statusLine: {
            ...(isObject(settings.statusLine) ? settings.statusLine : {type: 'command'}),
            command: statusLineCommand(scripts.statusLine, previous),
        },
    };
}

/** Adds Islet's hooks and status line. Idempotent: a connected file comes back unchanged. */
export function connectSettings(text: string | null, scripts: BridgeScripts): string {
    const settings = parse(text);
    const status = connectionStatus(text);
    if (status.hooks && status.statusLine && text !== null)
        return text;

    const planned = plannedEntries(text, scripts);
    const hooks: Json = isObject(settings.hooks) ? {...settings.hooks} : {};
    if (!status.hooks) {
        for (const [event, groups] of Object.entries(planned.hooks as Json)) {
            const existing = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
            hooks[event] = [...existing, ...(groups as unknown[])];
        }
    }
    return serialize({
        ...settings,
        hooks,
        statusLine: status.statusLine ? settings.statusLine : planned.statusLine,
    });
}

/**
 * Removes exactly what connect() added: Islet's hook entries (and groups or events left empty
 * by that) and its status line, restoring the chained previous command if there was one.
 */
export function disconnectSettings(text: string): string {
    const settings = parse(text);
    const result: Json = {...settings};

    if (isObject(settings.hooks)) {
        const hooks: Json = {};
        for (const [event, groups] of Object.entries(settings.hooks)) {
            if (!Array.isArray(groups)) {
                hooks[event] = groups;
                continue;
            }
            const kept = groups
                .map(group => isObject(group) && Array.isArray(group.hooks)
                    ? {...group, hooks: group.hooks.filter(hook => !isOurs(hook))}
                    : group)
                .filter(group => !(isObject(group) && Array.isArray(group.hooks) && group.hooks.length === 0));
            if (kept.length)
                hooks[event] = kept;
        }
        if (Object.keys(hooks).length)
            result.hooks = hooks;
        else
            delete result.hooks;
    }

    if (isOurs(settings.statusLine)) {
        const statusLine = settings.statusLine as Json;
        const previous = chainedPreviousCommand(statusLine.command as string);
        if (previous)
            result.statusLine = {...statusLine, command: previous};
        else
            delete result.statusLine;
    }
    return serialize(result);
}

/**
 * Whether two settings documents mean the same thing (used to restore the exact original bytes
 * when nothing else changed since connecting).
 */
export function sameSettings(a: string | null, b: string | null): boolean {
    try {
        return JSON.stringify(parse(a)) === JSON.stringify(parse(b));
    } catch {
        return false;
    }
}
