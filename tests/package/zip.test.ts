// SPDX-License-Identifier: GPL-2.0-or-later
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync, statSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';
import {DIST, REPO} from '../integration/harness.js';

const ZIP = join(REPO, 'islet@jagosar.github.io.zip');

function listZip(): string[] {
    return execFileSync('unzip', ['-Z1', ZIP], {encoding: 'utf8'}).split('\n').filter(entry => entry && !entry.endsWith('/'));
}

function* walk(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory())
            yield* walk(path);
        else
            yield path;
    }
}

describe('the extension package', () => {
    let entries: string[];
    beforeAll(() => {
        execFileSync(join(REPO, 'scripts/pack.sh'), {encoding: 'utf8'});
        entries = listZip();
    });

    it('contains everything GNOME Shell, the daemon and the tools load', () => {
        for (const required of [
            'metadata.json', 'extension.js', 'prefs.js', 'stylesheet.css', 'schemas/gschemas.compiled',
            'schemas/org.gnome.shell.extensions.islet.gschema.xml', 'daemon/main.js', 'bridge/hook.js',
            'bridge/statusline.js', 'tools/claudeConnection.js',
        ])
            expect(entries, required).toContain(required);
    });

    it('leaves out development tools and non-runtime files', () => {
        expect(entries.filter(entry => entry.startsWith('dev/'))).toEqual([]);
        expect(entries.filter(entry => /\.(ts|map|test\.js)$/.test(entry))).toEqual([]);
    });

    it('has a relative import target for every import, inside the package', () => {
        const inZip = new Set(entries);
        const missing: string[] = [];
        for (const file of walk(DIST)) {
            if (!file.endsWith('.js') || file.includes(`${join(DIST, 'dev')}`))
                continue;
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(/(?:from\s+|import\s*\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
                const target = relative(DIST, resolve(dirname(file), match[1]));
                // The development tools are loaded only if present (see IsletExtension.startDevDebug).
                if (!inZip.has(target) && !target.startsWith('dev/'))
                    missing.push(`${relative(DIST, file)} imports ${match[1]}`);
            }
        }
        expect(missing).toEqual([]);
    });

    it('has valid metadata that matches the package and the schema', () => {
        const metadata = JSON.parse(readFileSync(join(DIST, 'metadata.json'), 'utf8')) as Record<string, unknown>;
        const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {version: string};
        expect(metadata.uuid).toBe('islet@jagosar.github.io');
        expect(metadata['version-name']).toBe(pkg.version);
        expect(metadata['shell-version']).toEqual(['50']);
        expect(metadata['settings-schema']).toBe('org.gnome.shell.extensions.islet');
        const schema = readFileSync(join(REPO, 'schemas/org.gnome.shell.extensions.islet.gschema.xml'), 'utf8');
        expect(schema).toContain(`id="${String(metadata['settings-schema'])}"`);
        expect(String(metadata.url)).toMatch(/^https:\/\/github\.com\//);
    });

    it('compiles its schema', () => {
        expect(() => execFileSync('glib-compile-schemas', ['--strict', '--dry-run', join(DIST, 'schemas')])).not.toThrow();
    });

    it('has an SPDX license header in every shipped script (TypeScript keeps it only when a blank line follows)', () => {
        const withoutHeader = [...walk(DIST)]
            .filter(file => file.endsWith('.js'))
            .filter(file => !readFileSync(file, 'utf8').startsWith('// SPDX-License-Identifier: GPL-2.0-or-later'))
            .map(file => relative(DIST, file));
        expect(withoutHeader).toEqual([]);
    });
});
