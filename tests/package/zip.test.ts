// SPDX-License-Identifier: GPL-2.0-or-later
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
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

    it('has no development hooks: no environment switches, no debug service, no markers', () => {
        const offenders: string[] = [];
        const scratch = mkdtempSync(join(tmpdir(), 'islet-zip-'));
        try {
            execFileSync('unzip', ['-q', ZIP, '-d', scratch]);
            for (const file of walk(scratch)) {
                if (file.endsWith('.js') && /ISLET_DEV|debugService|DEV-ONLY|startDevDebug|ISLET_NESTED/.test(readFileSync(file, 'utf8')))
                    offenders.push(relative(scratch, file));
            }
        } finally {
            rmSync(scratch, {recursive: true, force: true});
        }
        expect(offenders).toEqual([]);
    });

    it('is syntactically valid JavaScript after the development code was stripped', () => {
        const scratch = mkdtempSync(join(tmpdir(), 'islet-syntax-'));
        try {
            execFileSync('unzip', ['-q', ZIP, '-d', scratch]);
            for (const file of walk(scratch).filter(f => f.endsWith('.js'))) {
                const copy = `${file}.mjs`; // Node checks .mjs as an ES module.
                writeFileSync(copy, readFileSync(file));
                expect(() => execFileSync('node', ['--check', copy], {stdio: 'pipe'}), relative(scratch, file)).not.toThrow();
            }
        } finally {
            rmSync(scratch, {recursive: true, force: true});
        }
    });

    it('follows the extensions.gnome.org import rules: no Gtk/Gdk/Adw in the Shell, no Clutter/Meta/St/Shell in prefs', () => {
        const libraries = (entry: string): Set<string> => {
            const found = new Set<string>();
            const queue = [join(DIST, entry)];
            const seen = new Set<string>();
            while (queue.length > 0) {
                const file = queue.pop()!;
                if (seen.has(file) || !existsSync(file))
                    continue;
                seen.add(file);
                for (const match of readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g)) {
                    if (match[1].startsWith('gi://'))
                        found.add(match[1].slice(5));
                    else if (match[1].startsWith('.'))
                        queue.push(resolve(dirname(file), match[1]));
                }
            }
            return found;
        };
        expect([...libraries('extension.js')].filter(name => ['Gtk', 'Gdk', 'Adw'].includes(name))).toEqual([]);
        expect([...libraries('prefs.js')].filter(name => ['Clutter', 'Meta', 'St', 'Shell'].includes(name))).toEqual([]);
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
