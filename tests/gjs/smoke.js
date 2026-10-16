// Runs the built pure core under GJS (the runtime of the extension and the daemon), where
// Intl, TextDecoder and module loading differ from Node. Usage: gjs -m tests/gjs/smoke.js
// after `npm run build`. Exits 1 on the first failed check.

import System from 'system';

import {describeAgentEvent, parseAgentEvent} from '../../dist/core/agentEvents.js';
import {formatTokens} from '../../dist/core/format.js';
import {hookFieldsFromJson} from '../../dist/core/hookInput.js';
import {UsageAggregator, dayKey} from '../../dist/core/usage/aggregator.js';
import {parseUsageLine} from '../../dist/core/usage/claudeTranscript.js';

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    print(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
    if (!ok)
        failures++;
}

check('dayKey uses the given time zone', dayKey('2026-10-15T22:30:00Z', 'Europe/Berlin'), '2026-10-16');

const line = JSON.stringify({
    type: 'assistant', sessionId: 's', timestamp: '2026-10-16T10:00:00Z',
    message: {id: 'm', model: 'claude-haiku-5-5', usage: {input_tokens: 1, output_tokens: 2}},
});
const aggregator = new UsageAggregator('Europe/Berlin');
aggregator.add(parseUsageLine(line));
aggregator.add(parseUsageLine(line));
check('a repeated response is counted once', aggregator.size, 1);

const fields = hookFieldsFromJson(JSON.stringify({
    session_id: 's', cwd: '/home/me/código/ñandú', hook_event_name: 'Notification',
    notification_type: 'permission_prompt', message: 'private',
}));
check('hook fields keep non-ASCII paths and drop the message', fields,
    {session_id: 's', cwd: '/home/me/código/ñandú', hook_event_name: 'Notification', notification_type: 'permission_prompt'});
check('an agent event becomes a live activity', describeAgentEvent(parseAgentEvent(fields)), 'ñandú needs your permission');
check('token counts keep three significant digits', formatTokens(1_120_000), '1.12M');

if (failures) {
    printerr(`${failures} GJS smoke check(s) failed`);
    System.exit(1);
}
