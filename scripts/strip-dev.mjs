// SPDX-License-Identifier: GPL-2.0-or-later
//
// Removes the development-only code from the built JavaScript before it is packaged: every
// region between a `// DEV-ONLY-BEGIN` and a `// DEV-ONLY-END` comment line, markers included.
// The packaged extension then has no test hooks and no environment-variable switches, which is
// what extensions.gnome.org reviewers (and users) should see.
//
//   node scripts/strip-dev.mjs FILE...      rewrites the files in place
import {readFileSync, writeFileSync} from 'node:fs';

const BEGIN = /^\s*\/\/ DEV-ONLY-BEGIN\b/;
const END = /^\s*\/\/ DEV-ONLY-END\b/;

/** Returns `source` without its dev-only regions. Throws if the markers do not pair up. */
export function stripDevOnly(source, name = 'input') {
    const kept = [];
    let inside = false;
    source.split('\n').forEach((line, index) => {
        if (BEGIN.test(line)) {
            if (inside)
                throw new Error(`${name}:${index + 1}: DEV-ONLY-BEGIN inside another DEV-ONLY region`);
            inside = true;
        } else if (END.test(line)) {
            if (!inside)
                throw new Error(`${name}:${index + 1}: DEV-ONLY-END without DEV-ONLY-BEGIN`);
            inside = false;
        } else if (!inside) {
            kept.push(line);
        }
    });
    if (inside)
        throw new Error(`${name}: DEV-ONLY-BEGIN without DEV-ONLY-END`);
    return kept.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
    for (const file of process.argv.slice(2))
        writeFileSync(file, stripDevOnly(readFileSync(file, 'utf8'), file));
}
