#!/usr/bin/env node
// SPDX-License-Identifier: GPL-2.0-or-later
// Development tool: how good is the 5-hour estimate on this computer's own history?
//
// It walks through the Claude desktop app's plan history in time order. For every pair of
// consecutive samples it estimates the later one from the earlier one and from the usage in the
// transcripts between them, with the pace learned from the intervals BEFORE it only (no peeking),
// and compares the estimate with the real sample. Prints counts and errors in percentage points,
// never message content. Run `npm run build` first.
//
// Usage: node scripts/plan-estimate-report.mjs

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {estimateFiveHour} from '../dist/core/planEstimate.js';
import {parseDesktopPlanSamples} from '../dist/core/planSources.js';
import {mayHoldUsage, parseUsageLine} from '../dist/core/usage/claudeTranscript.js';
import {InsightsCollector} from '../dist/core/usage/insights.js';

const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const history = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Claude', 'plan-usage-history.json');

function* transcripts(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory())
            yield* transcripts(path);
        else if (name.endsWith('.jsonl'))
            yield path;
    }
}

const samples = parseDesktopPlanSamples(readFileSync(history, 'utf8'));
if (!samples?.length) {
    console.log('no plan history found at', history);
    process.exit(1);
}

// The whole history of requests (the daemon keeps a week; here everything newer than the first sample).
const first = samples[0].at;
const collector = new InsightsCollector(() => first);
const seen = new Set();
for (const path of transcripts(join(config, 'projects'))) {
    for (const text of readFileSync(path, 'utf8').split('\n')) {
        if (!mayHoldUsage(text))
            continue;
        const record = parseUsageLine(text);
        if (record && !seen.has(record.messageId)) {
            seen.add(record.messageId);
            collector.add(record);
        }
    }
}
const weightBetween = (from, to) => collector.weightBetween(from, to);

const errors = [];
const ratios = [];
let skipped = 0;
for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const usable = a.fiveHour !== undefined && b.fiveHour !== undefined && b.fiveHour >= a.fiveHour && b.fiveHour < 100 &&
        b.at - a.at <= 25 * 60;
    if (!usable) {
        skipped++;
        continue;
    }
    // Estimate b from a, as the daemon would at b's time, knowing only the samples up to a.
    const plan = {measuredAt: a.at, source: 'desktop', fiveHour: {usedPercentage: a.fiveHour}};
    const estimate = estimateFiveHour(plan, samples.slice(0, i), b.at, weightBetween);
    if (!estimate) {
        skipped++;
        continue;
    }
    errors.push(Math.abs(estimate.fiveHour - b.fiveHour));
    const rise = b.fiveHour - a.fiveHour;
    const predicted = estimate.fiveHour - a.fiveHour;
    if (predicted > 0)
        ratios.push(rise / predicted);
}

const sorted = values => [...values].sort((x, y) => x - y);
const at = (values, q) => sorted(values)[Math.min(values.length - 1, Math.floor(values.length * q))];
console.log(`samples: ${samples.length}, intervals estimated: ${errors.length}, skipped: ${skipped}`);
if (errors.length) {
    const mean = errors.reduce((x, y) => x + y, 0) / errors.length;
    console.log(`mean absolute error: ${mean.toFixed(2)} points (median ${at(errors, 0.5).toFixed(2)}, p90 ${at(errors, 0.9).toFixed(2)})`);
    console.log(`actual rise / estimated rise: median ${at(ratios, 0.5).toFixed(2)} (p10 ${at(ratios, 0.1).toFixed(2)} to p90 ${at(ratios, 0.9).toFixed(2)})`);
}
