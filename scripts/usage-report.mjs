#!/usr/bin/env node
// Development tool: runs the built usage core over every Claude Code transcript and compares
// each ended session's transcript totals with the `cost-state` Claude Code wrote for it (spike
// S5). Prints token counts only, never message content. Run `npm run build` first.
//
// Usage: node scripts/usage-report.mjs [time zone, default: the system's]

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {UsageAggregator} from '../dist/core/usage/aggregator.js';
import {freshTokens, mayHoldUsage, parseCostStateLine, parseUsageLine} from '../dist/core/usage/claudeTranscript.js';

const timeZone = process.argv[2] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

function* transcripts(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory())
            yield* transcripts(path);
        else if (name.endsWith('.jsonl'))
            yield path;
    }
}

const aggregator = new UsageAggregator(timeZone);
const references = new Map();
let lines = 0;
for (const file of transcripts(root)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        lines++;
        if (!mayHoldUsage(line))
            continue;
        const record = parseUsageLine(line);
        if (record) {
            aggregator.add(record);
            continue;
        }
        const costState = parseCostStateLine(line);
        if (costState) {
            references.set(costState.sessionId, costState.models);
            aggregator.setSessionReference(costState.sessionId, costState.models);
        }
    }
}

console.log(`${lines} lines, ${aggregator.size} responses, time zone ${timeZone}\n`);

console.log('Transcript totals against cost-state, for ended sessions:');
const fields = ['input', 'cacheWrite', 'cacheRead', 'output'];
const sessions = aggregator.bySession();
let compared = 0;
for (const [sessionId, models] of references) {
    for (const [model, expected] of models) {
        compared++;
        const actual = sessions.get(sessionId)?.get(model);
        const diffs = fields
            .filter(field => (actual?.[field] ?? 0) !== expected[field])
            .map(field => `${field} ${actual?.[field] ?? 0} vs ${expected[field]}`);
        console.log(`  ${sessionId.slice(0, 8)} ${model.padEnd(26)} ${diffs.length ? `differs (reconciled): ${diffs.join(', ')}` : 'match'}`);
    }
}
if (!compared)
    console.log('  none yet (Claude Code writes cost-state when a session ends)');

console.log('\nFresh tokens per day (reconciled):');
for (const [day, models] of [...aggregator.byDay()].sort()) {
    const parts = [...models].map(([model, tokens]) => `${model} ${freshTokens(tokens).toLocaleString('en')}`);
    console.log(`  ${day}  ${parts.join(' · ')}`);
}
