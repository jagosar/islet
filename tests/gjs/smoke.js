// Runs the built pure core under GJS (the runtime of the extension and the daemon), where
// Intl, TextDecoder and module loading differ from Node. Usage: gjs -m tests/gjs/smoke.js
// after `npm run build`. Exits 1 on the first failed check.

import System from 'system';

import {describeAgentEvent, parseAgentEvent} from '../../dist/core/agentEvents.js';
import {formatTokens} from '../../dist/core/format.js';
import {hookFieldsFromJson} from '../../dist/core/hookInput.js';
import {UsageAggregator, dayKey} from '../../dist/core/usage/aggregator.js';
import {parseDesktopPlanHistory} from '../../dist/core/planSources.js';
import {parseResetTime, parseUsageLine} from '../../dist/core/usage/claudeTranscript.js';
import {InsightsCollector} from '../../dist/core/usage/insights.js';

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

// Reset times convert a wall-clock time in a named zone: Intl with time zones, in SpiderMonkey.
check('a limit reset time is read in its time zone',
    parseResetTime('resets 4:20pm (Europe/Berlin)', Date.parse('2026-10-18T12:35:21Z')), Date.parse('2026-10-18T14:20:00Z') / 1000);
check('a reset just before the autumn time change keeps summer time',
    parseResetTime('resets 1:30am (Europe/Berlin)', Date.parse('2026-10-24T20:00:00Z')), Date.parse('2026-10-24T23:30:00Z') / 1000);
check('the desktop app history is read', parseDesktopPlanHistory('{"version":2,"samples":[{"t":1000,"u":{"fh":45,"sd":20}}]}'),
    {measuredAt: 1, source: 'desktop', fiveHour: {usedPercentage: 45}, sevenDay: {usedPercentage: 20}});
const collector = new InsightsCollector(() => 1_792_400_000);
collector.add({...parseUsageLine(line), timestamp: new Date(1_792_399_000_000).toISOString(), attribution: {skill: 'architect'}});
check('insights attribute a response to its skill', collector.build(1_792_400_000).day.attribution.map(row => row.name), ['architect']);

if (failures) {
    printerr(`${failures} GJS smoke check(s) failed`);
    System.exit(1);
}
