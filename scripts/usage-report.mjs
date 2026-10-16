#!/usr/bin/env node
// Development tool (spike S5): runs the built usage core over every Claude Code transcript and
// compares each session's totals with the `cost-state` entry Claude Code writes when a session
// ends. Prints token counts only, never message content. Run `npm run build` first.
//
// Usage: node scripts/usage-report.mjs [time zone, default: the system's]

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {UsageAggregator} from '../dist/core/usage/aggregator.js';
import {freshTokens, parseUsageLine} from '../dist/core/usage/claudeTranscript.js';

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

const aggregator = new UsageAggregator();
const references = new Map(); // sessionId -> modelUsage from the last cost-state
let lines = 0;
for (const file of transcripts(root)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        lines++;
        const record = parseUsageLine(line);
        if (record)
            aggregator.add(record);
        else if (line.includes('"cost-state"')) {
            const entry = JSON.parse(line);
            references.set(entry.sessionId, entry.modelUsage ?? {});
        }
    }
}

console.log(`${lines} lines, ${aggregator.size} responses, time zone ${timeZone}\n`);

console.log('Sessions with a Claude Code reference (cost-state):');
const fields = [['input', 'inputTokens'], ['cacheWrite', 'cacheCreationInputTokens'], ['cacheRead', 'cacheReadInputTokens'], ['output', 'outputTokens']];
const sessions = aggregator.bySession();
let compared = 0;
let mismatches = 0;
for (const [sessionId, reference] of references) {
    for (const [model, expected] of Object.entries(reference)) {
        compared++;
        const actual = sessions.get(sessionId)?.get(model);
        const diffs = fields
            .filter(([ours, theirs]) => (actual?.[ours] ?? 0) !== (expected[theirs] ?? 0))
            .map(([ours, theirs]) => `${ours} ${actual?.[ours] ?? 0} vs ${expected[theirs]}`);
        if (diffs.length)
            mismatches++;
        console.log(`  ${sessionId.slice(0, 8)} ${model.padEnd(20)} ${diffs.length ? `MISMATCH: ${diffs.join(', ')}` : 'match'}`);
    }
}
if (!compared)
    console.log('  none yet (Claude Code writes cost-state when a session ends)');

console.log('\nFresh tokens per day:');
for (const [day, models] of [...aggregator.byDay(timeZone)].sort()) {
    const parts = [...models].map(([model, tokens]) => `${model} ${freshTokens(tokens).toLocaleString('en')}`);
    console.log(`  ${day}  ${parts.join(' · ')}`);
}

process.exitCode = mismatches ? 1 : 0;
